// ptfile.go — reading a PyTorch state dict (.pt) without PyTorch.
//
// A .pt file saved by torch.save (the zip format, PyTorch 1.6+) is a zip with
// <prefix>/data.pkl, a pickle describing the state dict, and <prefix>/data/<key>
// files holding each tensor's raw storage. The pickle needs only a handful of
// opcodes and four globals for a state dict of float tensors, which is all
// this implements: it is a reader for model weights, not a general unpickler,
// and anything outside that set is an error rather than a guess.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
)

// ptTensor is one float32 tensor from a state dict, contiguous, row-major.
type ptTensor struct {
	Shape []int
	Data  []float32
}

func (t ptTensor) numel() int {
	n := 1
	for _, d := range t.Shape {
		n *= d
	}
	return n
}

type pyGlobal struct{ module, name string }
type pyMark struct{}
type pyStorage struct {
	kind, key string
	numel     int
}
type pyTensorRef struct {
	storage pyStorage
	offset  int
	size    []int
	stride  []int
}
type pyDict struct {
	keys []interface{}
	vals map[interface{}]interface{}
}

func newPyDict() *pyDict { return &pyDict{vals: map[interface{}]interface{}{}} }

func (d *pyDict) set(k, v interface{}) {
	if _, ok := d.vals[k]; !ok {
		d.keys = append(d.keys, k)
	}
	d.vals[k] = v
}

// readPtStateDict returns the float tensors of a state dict, by name. Integer
// tensors (BatchNorm's num_batches_tracked) are skipped.
func readPtStateDict(pt []byte) (map[string]ptTensor, error) {
	zr, err := zip.NewReader(bytes.NewReader(pt), int64(len(pt)))
	if err != nil {
		return nil, fmt.Errorf("pt: %w", err)
	}
	files := map[string]*zip.File{}
	var pkl *zip.File
	for _, f := range zr.File {
		files[f.Name] = f
		if strings.HasSuffix(f.Name, "/data.pkl") {
			pkl = f
		}
	}
	if pkl == nil {
		return nil, errors.New("pt: no data.pkl (not a zip-format torch.save file)")
	}
	prefix := strings.TrimSuffix(pkl.Name, "data.pkl")
	if bo, ok := files[prefix+"byteorder"]; ok {
		if b, err := readZipFile(bo); err == nil && strings.TrimSpace(string(b)) != "little" {
			return nil, fmt.Errorf("pt: byte order %q not supported", strings.TrimSpace(string(b)))
		}
	}
	raw, err := readZipFile(pkl)
	if err != nil {
		return nil, err
	}
	root, err := unpickleStateDict(raw)
	if err != nil {
		return nil, err
	}
	dict, ok := root.(*pyDict)
	if !ok {
		return nil, errors.New("pt: the pickle is not a state dict")
	}

	storages := map[string][]byte{}
	out := map[string]ptTensor{}
	for _, k := range dict.keys {
		name, _ := k.(string)
		ref, ok := dict.vals[k].(pyTensorRef)
		if !ok || name == "" {
			continue
		}
		if ref.storage.kind != "FloatStorage" {
			continue
		}
		b, ok := storages[ref.storage.key]
		if !ok {
			f := files[prefix+"data/"+ref.storage.key]
			if f == nil {
				return nil, fmt.Errorf("pt: storage %s missing", ref.storage.key)
			}
			if b, err = readZipFile(f); err != nil {
				return nil, err
			}
			storages[ref.storage.key] = b
		}
		t := ptTensor{Shape: ref.size}
		n := t.numel()
		// Contiguous row-major only: every tensor in a saved state dict is.
		want := 1
		for i := len(ref.size) - 1; i >= 0; i-- {
			if ref.size[i] != 1 && ref.stride[i] != want {
				return nil, fmt.Errorf("pt: %s is not contiguous", name)
			}
			want *= ref.size[i]
		}
		if (ref.offset+n)*4 > len(b) {
			return nil, fmt.Errorf("pt: %s runs past its storage", name)
		}
		t.Data = make([]float32, n)
		for i := range t.Data {
			t.Data[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[(ref.offset+i)*4:]))
		}
		out[name] = t
	}
	return out, nil
}

func readZipFile(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// unpickleStateDict runs the subset of the pickle machine a state dict uses.
func unpickleStateDict(b []byte) (interface{}, error) {
	var (
		stack []interface{}
		memo  = map[int]interface{}{}
		pos   int
	)
	need := func(n int) ([]byte, error) {
		if pos+n > len(b) {
			return nil, errors.New("pt: truncated pickle")
		}
		s := b[pos : pos+n]
		pos += n
		return s, nil
	}
	pop := func() (interface{}, error) {
		if len(stack) == 0 {
			return nil, errors.New("pt: pickle stack underflow")
		}
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		return v, nil
	}
	popMark := func() ([]interface{}, error) {
		for i := len(stack) - 1; i >= 0; i-- {
			if _, ok := stack[i].(pyMark); ok {
				items := append([]interface{}(nil), stack[i+1:]...)
				stack = stack[:i]
				return items, nil
			}
		}
		return nil, errors.New("pt: pickle mark not found")
	}
	readLine := func() (string, error) {
		i := pos
		for i < len(b) && b[i] != '\n' {
			i++
		}
		if i >= len(b) {
			return "", errors.New("pt: truncated pickle")
		}
		s := string(b[pos:i])
		pos = i + 1
		return s, nil
	}
	ints := func(v interface{}) ([]int, error) {
		t, ok := v.([]interface{})
		if !ok {
			return nil, errors.New("pt: expected a tuple of ints")
		}
		out := make([]int, len(t))
		for i, x := range t {
			n, ok := x.(int)
			if !ok {
				return nil, errors.New("pt: expected an int")
			}
			out[i] = n
		}
		return out, nil
	}

	for {
		op, err := need(1)
		if err != nil {
			return nil, err
		}
		switch op[0] {
		case 0x80: // PROTO
			if _, err := need(1); err != nil {
				return nil, err
			}
		case '}': // EMPTY_DICT
			stack = append(stack, newPyDict())
		case ')': // EMPTY_TUPLE
			stack = append(stack, []interface{}{})
		case '(': // MARK
			stack = append(stack, pyMark{})
		case 'N': // NONE
			stack = append(stack, nil)
		case 0x88: // NEWTRUE
			stack = append(stack, true)
		case 0x89: // NEWFALSE
			stack = append(stack, false)
		case 'K': // BININT1
			v, err := need(1)
			if err != nil {
				return nil, err
			}
			stack = append(stack, int(v[0]))
		case 'M': // BININT2
			v, err := need(2)
			if err != nil {
				return nil, err
			}
			stack = append(stack, int(binary.LittleEndian.Uint16(v)))
		case 'J': // BININT
			v, err := need(4)
			if err != nil {
				return nil, err
			}
			stack = append(stack, int(int32(binary.LittleEndian.Uint32(v))))
		case 0x8a: // LONG1
			n, err := need(1)
			if err != nil {
				return nil, err
			}
			v, err := need(int(n[0]))
			if err != nil {
				return nil, err
			}
			if len(v) > 8 {
				return nil, errors.New("pt: integer too large")
			}
			var x int64
			for i := len(v) - 1; i >= 0; i-- {
				x = x<<8 | int64(v[i])
			}
			if len(v) > 0 && len(v) < 8 && v[len(v)-1]&0x80 != 0 {
				x -= 1 << (8 * uint(len(v)))
			}
			stack = append(stack, int(x))
		case 'G': // BINFLOAT
			v, err := need(8)
			if err != nil {
				return nil, err
			}
			stack = append(stack, math.Float64frombits(binary.BigEndian.Uint64(v)))
		case 'X': // BINUNICODE
			n, err := need(4)
			if err != nil {
				return nil, err
			}
			s, err := need(int(binary.LittleEndian.Uint32(n)))
			if err != nil {
				return nil, err
			}
			stack = append(stack, string(s))
		case 'c': // GLOBAL
			mod, err := readLine()
			if err != nil {
				return nil, err
			}
			name, err := readLine()
			if err != nil {
				return nil, err
			}
			stack = append(stack, pyGlobal{mod, name})
		case 'q': // BINPUT
			v, err := need(1)
			if err != nil {
				return nil, err
			}
			if len(stack) == 0 {
				return nil, errors.New("pt: BINPUT on empty stack")
			}
			memo[int(v[0])] = stack[len(stack)-1]
		case 'r': // LONG_BINPUT
			v, err := need(4)
			if err != nil {
				return nil, err
			}
			if len(stack) == 0 {
				return nil, errors.New("pt: LONG_BINPUT on empty stack")
			}
			memo[int(binary.LittleEndian.Uint32(v))] = stack[len(stack)-1]
		case 'h': // BINGET
			v, err := need(1)
			if err != nil {
				return nil, err
			}
			x, ok := memo[int(v[0])]
			if !ok {
				return nil, errors.New("pt: BINGET of unknown memo")
			}
			stack = append(stack, x)
		case 'j': // LONG_BINGET
			v, err := need(4)
			if err != nil {
				return nil, err
			}
			x, ok := memo[int(binary.LittleEndian.Uint32(v))]
			if !ok {
				return nil, errors.New("pt: LONG_BINGET of unknown memo")
			}
			stack = append(stack, x)
		case 't': // TUPLE
			items, err := popMark()
			if err != nil {
				return nil, err
			}
			stack = append(stack, items)
		case 0x85, 0x86, 0x87: // TUPLE1, TUPLE2, TUPLE3
			n := int(op[0]-0x85) + 1
			if len(stack) < n {
				return nil, errors.New("pt: pickle stack underflow")
			}
			items := append([]interface{}(nil), stack[len(stack)-n:]...)
			stack = append(stack[:len(stack)-n], items)
		case 'Q': // BINPERSID: ('storage', torch.<Kind>Storage, key, location, numel)
			pid, err := pop()
			if err != nil {
				return nil, err
			}
			t, ok := pid.([]interface{})
			if !ok || len(t) < 5 {
				return nil, errors.New("pt: unexpected persistent id")
			}
			g, _ := t[1].(pyGlobal)
			key, _ := t[2].(string)
			numel, _ := t[4].(int)
			if tag, _ := t[0].(string); tag != "storage" || g.module != "torch" || key == "" {
				return nil, errors.New("pt: unexpected persistent id")
			}
			stack = append(stack, pyStorage{kind: g.name, key: key, numel: numel})
		case 'R': // REDUCE
			args, err := pop()
			if err != nil {
				return nil, err
			}
			fn, err := pop()
			if err != nil {
				return nil, err
			}
			g, ok := fn.(pyGlobal)
			a, _ := args.([]interface{})
			switch {
			case ok && g.module == "collections" && g.name == "OrderedDict":
				stack = append(stack, newPyDict())
			case ok && g.module == "torch._utils" && g.name == "_rebuild_tensor_v2":
				if len(a) < 4 {
					return nil, errors.New("pt: bad _rebuild_tensor_v2 call")
				}
				st, ok1 := a[0].(pyStorage)
				off, ok2 := a[1].(int)
				size, err1 := ints(a[2])
				stride, err2 := ints(a[3])
				if !ok1 || !ok2 || err1 != nil || err2 != nil || len(size) != len(stride) {
					return nil, errors.New("pt: bad _rebuild_tensor_v2 call")
				}
				stack = append(stack, pyTensorRef{storage: st, offset: off, size: size, stride: stride})
			default:
				return nil, fmt.Errorf("pt: unsupported call %s.%s", g.module, g.name)
			}
		case 's': // SETITEM
			v, err := pop()
			if err != nil {
				return nil, err
			}
			k, err := pop()
			if err != nil {
				return nil, err
			}
			if len(stack) == 0 {
				return nil, errors.New("pt: SETITEM without a dict")
			}
			d, ok := stack[len(stack)-1].(*pyDict)
			if !ok {
				return nil, errors.New("pt: SETITEM on a non-dict")
			}
			d.set(k, v)
		case 'u': // SETITEMS
			items, err := popMark()
			if err != nil {
				return nil, err
			}
			if len(stack) == 0 || len(items)%2 != 0 {
				return nil, errors.New("pt: bad SETITEMS")
			}
			d, ok := stack[len(stack)-1].(*pyDict)
			if !ok {
				return nil, errors.New("pt: SETITEMS on a non-dict")
			}
			for i := 0; i < len(items); i += 2 {
				d.set(items[i], items[i+1])
			}
		case 'b': // BUILD: state for the object below; a state dict's is metadata
			if _, err := pop(); err != nil {
				return nil, err
			}
		case '.': // STOP
			return pop()
		default:
			return nil, fmt.Errorf("pt: unsupported pickle opcode 0x%02x at %d", op[0], pos-1)
		}
	}
}
