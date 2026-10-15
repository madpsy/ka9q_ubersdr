
//go:build amd64 && !purego

#include "textflag.h"

// AVX2 kernels of the order-16 complex stage; see pcm_predictive_simd.go for why int32
// lanes are exact. Each 16-entry array is two YMM registers of eight int32
// lanes, lane 0 oldest, held from the first frame to the last:
//
//	Y0 Y1  hr      Y4 Y5  wr      Y8   lane rotation for the window slide
//	Y2 Y3  hi      Y6 Y7  wi      Y9   +tapLimit, Y10 -tapLimit
//	Y11-Y15        scratch
//
// Per frame: predict from the window, form the residual (or the sample),
// adapt against the window's signs, then slide the window a lane with the
// sample in at the top.

DATA rot<>+0(SB)/4, $1
DATA rot<>+4(SB)/4, $2
DATA rot<>+8(SB)/4, $3
DATA rot<>+12(SB)/4, $4
DATA rot<>+16(SB)/4, $5
DATA rot<>+20(SB)/4, $6
DATA rot<>+24(SB)/4, $7
DATA rot<>+28(SB)/4, $0
GLOBL rot<>(SB), RODATA|NOPTR, $32

DATA lim<>+0(SB)/4, $0x01000000
GLOBL lim<>(SB), RODATA|NOPTR, $4

DATA nlim<>+0(SB)/4, $0xff000000
GLOBL nlim<>(SB), RODATA|NOPTR, $4

// Even lanes of one half's four products into the accumulators:
// accR += wr*hr - wi*hi, accI += wr*hi + wi*hr.
#define PRODUCTS_EVEN(wr, wi, hr, hi) \
	VPMULDQ hr, wr, Y13 \
	VPADDQ  Y13, Y11, Y11 \
	VPMULDQ hi, wr, Y13 \
	VPADDQ  Y13, Y12, Y12 \
	VPMULDQ hi, wi, Y13 \
	VPSUBQ  Y13, Y11, Y11 \
	VPMULDQ hr, wi, Y13 \
	VPADDQ  Y13, Y12, Y12

// The odd lanes, each shifted down into the low half of its quadword, which
// is all VPMULDQ reads.
#define PRODUCTS_ODD(wr, wi, hr, hi) \
	VPSRLQ  $32, wr, Y14 \
	VPSRLQ  $32, hr, Y15 \
	VPMULDQ Y15, Y14, Y13 \
	VPADDQ  Y13, Y11, Y11 \
	VPSRLQ  $32, hi, Y15 \
	VPMULDQ Y15, Y14, Y13 \
	VPADDQ  Y13, Y12, Y12 \
	VPSRLQ  $32, wi, Y14 \
	VPMULDQ Y15, Y14, Y13 \
	VPSUBQ  Y13, Y11, Y11 \
	VPSRLQ  $32, hr, Y15 \
	VPMULDQ Y15, Y14, Y13 \
	VPADDQ  Y13, Y12, Y12

// The prediction, rounded: AX = real, BX = imaginary. DX is clobbered.
#define PREDICT \
	VPXOR        Y11, Y11, Y11 \
	VPXOR        Y12, Y12, Y12 \
	PRODUCTS_EVEN(Y4, Y6, Y0, Y2) \
	PRODUCTS_EVEN(Y5, Y7, Y1, Y3) \
	PRODUCTS_ODD(Y4, Y6, Y0, Y2) \
	PRODUCTS_ODD(Y5, Y7, Y1, Y3) \
	VEXTRACTI128 $1, Y11, X13 \
	VPADDQ       X13, X11, X11 \
	VEXTRACTI128 $1, Y12, X14 \
	VPADDQ       X14, X12, X12 \
	VPUNPCKLQDQ  X12, X11, X13 \
	VPUNPCKHQDQ  X12, X11, X14 \
	VPADDQ       X14, X13, X13 \
	VMOVQ        X13, AX \
	VPEXTRQ      $1, X13, BX \
	ROUND16(AX, DX) \
	ROUND16(BX, DX)

// roundShift(v, 16) in place, branch-free; m is clobbered.
#define ROUND16(v, m) \
	MOVQ v, m \
	SARQ $63, m \
	XORQ m, v \
	SUBQ m, v \
	ADDQ $0x8000, v \
	SHRQ $16, v \
	XORQ m, v \
	SUBQ m, v

// adapt on one half, with mr*sgn(er) broadcast in Y11 and mi*sgn(ei) in Y12:
// wr += mr*sgn(hr) + mi*sgn(hi) - leak(wr),
// wi += mi*sgn(hr) - mr*sgn(hi) - leak(wi), each clamped. leak is |w|>>14
// with w's sign put back, zero for a zero tap.
#define ADAPT_HALF(wr, wi, hr, hi) \
	VPSIGND hr, Y11, Y13 \
	VPSIGND hi, Y12, Y14 \
	VPADDD  Y14, Y13, Y13 \
	VPABSD  wr, Y14 \
	VPSRLD  $14, Y14, Y14 \
	VPSIGND wr, Y14, Y14 \
	VPADDD  Y13, wr, wr \
	VPSUBD  Y14, wr, wr \
	VPMINSD Y9, wr, wr \
	VPMAXSD Y10, wr, wr \
	VPSIGND hr, Y12, Y13 \
	VPSIGND hi, Y11, Y14 \
	VPSUBD  Y14, Y13, Y13 \
	VPABSD  wi, Y14 \
	VPSRLD  $14, Y14, Y14 \
	VPSIGND wi, Y14, Y14 \
	VPADDD  Y13, wi, wi \
	VPSUBD  Y14, wi, wi \
	VPMINSD Y9, wi, wi \
	VPMAXSD Y10, wi, wi

// m = mu * sgn(e); t is clobbered.
#define STEP(e, m, t) \
	MOVQ  e, m \
	SARQ  $63, m \
	MOVQ  e, t \
	NEGQ  t \
	SHRQ  $63, t \
	ORQ   t, m \
	IMULQ R9, m

// adapt on the residual in R12, R13, skipped when both are zero. AX, BX and
// DX are clobbered.
#define ADAPT(skip) \
	MOVQ         R12, DX \
	ORQ          R13, DX \
	JZ           skip \
	STEP(R12, AX, DX) \
	STEP(R13, BX, DX) \
	VMOVD        AX, X11 \
	VPBROADCASTD X11, Y11 \
	VMOVD        BX, X12 \
	VPBROADCASTD X12, Y12 \
	ADAPT_HALF(Y4, Y6, Y0, Y2) \
	ADAPT_HALF(Y5, Y7, Y1, Y3)

// Slide one history array a lane: lane 0 out, the sample in x at lane 15.
#define SLIDE(h0, h1, x) \
	VPERMD       h0, Y8, Y13 \
	VPERMD       h1, Y8, Y14 \
	VPBLENDD     $0x80, Y14, Y13, h0 \
	VMOVD        x, X15 \
	VPBROADCASTD X15, Y15 \
	VPBLENDD     $0x80, Y15, Y14, h1

#define LOAD_STATE \
	VMOVDQU      0(R8), Y4 \
	VMOVDQU      32(R8), Y5 \
	VMOVDQU      64(R8), Y6 \
	VMOVDQU      96(R8), Y7 \
	VMOVDQU      128(R8), Y0 \
	VMOVDQU      160(R8), Y1 \
	VMOVDQU      192(R8), Y2 \
	VMOVDQU      224(R8), Y3 \
	VMOVDQU      rot<>(SB), Y8 \
	VPBROADCASTD lim<>(SB), Y9 \
	VPBROADCASTD nlim<>(SB), Y10

#define STORE_STATE \
	VMOVDQU Y4, 0(R8) \
	VMOVDQU Y5, 32(R8) \
	VMOVDQU Y6, 64(R8) \
	VMOVDQU Y7, 96(R8) \
	VMOVDQU Y0, 128(R8) \
	VMOVDQU Y1, 160(R8) \
	VMOVDQU Y2, 192(R8) \
	VMOVDQU Y3, 224(R8) \
	VZEROUPPER

// func pcmv4SIMDForward(st *pcmv4SIMDState, samples *int16, res *int32, frames int, mu int64)
TEXT ·pcmv4SIMDForward(SB), NOSPLIT, $0-40
	MOVQ st+0(FP), R8
	MOVQ samples+8(FP), SI
	MOVQ res+16(FP), DI
	MOVQ frames+24(FP), CX
	MOVQ mu+32(FP), R9
	LOAD_STATE
	TESTQ CX, CX
	JLE   fdone

floop:
	PREDICT
	// R10, R11 = the sample; R12, R13 = its residual.
	MOVWQSX 0(SI), R10
	MOVWQSX 2(SI), R11
	MOVQ    R10, R12
	SUBQ    AX, R12
	MOVQ    R11, R13
	SUBQ    BX, R13
	MOVL    R12, 0(DI)
	MOVL    R13, 4(DI)
	ADAPT(fslide)

fslide:
	SLIDE(Y0, Y1, R10)
	SLIDE(Y2, Y3, R11)
	ADDQ $4, SI
	ADDQ $8, DI
	DECQ CX
	JNZ  floop

fdone:
	STORE_STATE
	RET

// func pcmv4SIMDInverse(st *pcmv4SIMDState, res *int32, out *int16, frames int, mu int64) int
TEXT ·pcmv4SIMDInverse(SB), NOSPLIT, $0-48
	MOVQ st+0(FP), R8
	MOVQ res+8(FP), SI
	MOVQ out+16(FP), DI
	MOVQ frames+24(FP), CX
	MOVQ mu+32(FP), R9
	LOAD_STATE
	TESTQ CX, CX
	JLE   idone

iloop:
	PREDICT
	// R12, R13 = the residual; R10, R11 = the sample.
	MOVLQSX 0(SI), R12
	MOVLQSX 4(SI), R13
	MOVQ    R12, R10
	ADDQ    AX, R10
	MOVQ    R13, R11
	ADDQ    BX, R11

	// A sample past int32 cannot enter the int32 window: stop before it.
	MOVLQSX R10, DX
	CMPQ    DX, R10
	JNE     idone
	MOVLQSX R11, DX
	CMPQ    DX, R11
	JNE     idone

	MOVW R10, 0(DI)
	MOVW R11, 2(DI)
	ADAPT(islide)

islide:
	SLIDE(Y0, Y1, R10)
	SLIDE(Y2, Y3, R11)
	ADDQ $8, SI
	ADDQ $4, DI
	DECQ CX
	JNZ  iloop

idone:
	// CX frames were not done (none left on a full run, never negative
	// after the JLE above takes the empty case).
	STORE_STATE
	MOVQ frames+24(FP), AX
	CMPQ CX, $0
	JGE  icount
	XORQ CX, CX

icount:
	SUBQ CX, AX
	MOVQ AX, ret+40(FP)
	RET

// func pcmv4HasAVX2() bool
TEXT ·pcmv4HasAVX2(SB), NOSPLIT, $0-1
	// Leaf 7 must exist.
	XORL  AX, AX
	CPUID
	CMPL  AX, $7
	JLT   no

	// AVX and OSXSAVE (leaf 1 ECX bits 28 and 27) ...
	MOVL  $1, AX
	XORL  CX, CX
	CPUID
	ANDL  $0x18000000, CX
	CMPL  CX, $0x18000000
	JNE   no

	// ... the OS saving the XMM and YMM state (XCR0 bits 1 and 2) ...
	XORL   CX, CX
	XGETBV
	ANDL   $6, AX
	CMPL   AX, $6
	JNE    no

	// ... and AVX2 (leaf 7 EBX bit 5).
	MOVL  $7, AX
	XORL  CX, CX
	CPUID
	BTL   $5, BX
	JCC   no

	MOVB $1, ret+0(FP)
	RET

no:
	MOVB $0, ret+0(FP)
	RET
