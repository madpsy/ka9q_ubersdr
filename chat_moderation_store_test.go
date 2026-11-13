package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestChatModerationStoreMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat_moderation.yaml")
	s := NewChatModerationStore(path)
	if !reflect.DeepEqual(s.Settings(), DefaultChatModerationSettings()) {
		t.Errorf("settings = %+v, want defaults", s.Settings())
	}
	if s.Filter() == nil || s.Filter().Check("shit").Output != "s**t" {
		t.Error("default filter not working")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("store created the file without an update")
	}
}

func TestChatModerationStoreBadFile(t *testing.T) {
	dir := t.TempDir()
	for name, content := range map[string]string{
		"garbage":  "mode: [unclosed\n  words: {",
		"bad enum": "mode: shout\n",
	} {
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "_")+".yaml")
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		s := NewChatModerationStore(path)
		if !reflect.DeepEqual(s.Settings(), DefaultChatModerationSettings()) {
			t.Errorf("%s: settings = %+v, want defaults", name, s.Settings())
		}
	}
}

func TestChatModerationStorePartialFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat_moderation.yaml")
	if err := os.WriteFile(path, []byte("mode: block\nwords: [Muppet, ab]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	s := NewChatModerationStore(path)
	got := s.Settings()
	want := DefaultChatModerationSettings()
	want.Mode = ChatModeBlock
	want.Words = []string{"muppet"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("settings = %+v, want %+v", got, want)
	}
}

func TestChatModerationStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat_moderation.yaml")
	s := NewChatModerationStore(path)
	in := ChatModerationSettings{
		Mode:          "Block",
		Words:         []string{"Muppet", "fuck", "shit", "ab"},
		Links:         "allowlist",
		LinkAllowlist: []string{"https://www.qrz.com/db", "dxwatch.com"},
		AutoModeration: ChatAutoModeration{
			Enabled: false, Strikes: 5, WindowMinutes: 15, ChatBanMinutes: 1440,
		},
		SDREscalation: ChatSDREscalation{Enabled: true, ChatBans: 2, WindowDays: 7},
	}
	out, notes, rejected, err := s.Update(in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Mode != ChatModeBlock || strings.Join(out.Words, ",") != "muppet" ||
		strings.Join(out.LinkAllowlist, ",") != "qrz.com,dxwatch.com" {
		t.Errorf("out = %+v", out)
	}
	if len(notes) != 1 || notes[0] != "2 words are already in the built-in list" {
		t.Errorf("notes = %q", notes)
	}
	if len(rejected) != 1 || rejected[0].Word != "ab" {
		t.Errorf("rejected = %+v", rejected)
	}
	if !reflect.DeepEqual(s.Settings(), out) {
		t.Errorf("Settings() = %+v, want %+v", s.Settings(), out)
	}
	if res := s.Filter().Check("you muppet"); res.Status != ChatStatusBlocked {
		t.Errorf("filter not swapped: %+v", res)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0644 {
		t.Errorf("file mode = %v", info.Mode().Perm())
	}
	data, _ := os.ReadFile(path)
	for _, key := range []string{"mode:", "words:", "links:", "link_allowlist:", "auto_moderation:",
		"strikes:", "window_minutes:", "chat_ban_minutes:", "sdr_escalation:", "chat_bans:", "window_days:"} {
		if !strings.Contains(string(data), key) {
			t.Errorf("saved file lacks %q:\n%s", key, data)
		}
	}
	if !reflect.DeepEqual(NewChatModerationStore(path).Settings(), out) {
		t.Errorf("reload = %+v, want %+v", NewChatModerationStore(path).Settings(), out)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".chat_moderation-*"))
	if len(leftovers) != 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}
}

func TestChatModerationStoreUpdateErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat_moderation.yaml")
	s := NewChatModerationStore(path)
	bad := DefaultChatModerationSettings()
	bad.Links = "never"
	if _, _, _, err := s.Update(bad); err == nil {
		t.Error("no error for bad links value")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("file written for invalid settings")
	}

	// Unwritable location: error, and the old settings stay live.
	s2 := NewChatModerationStore(filepath.Join(t.TempDir(), "missing-dir", "chat_moderation.yaml"))
	good := DefaultChatModerationSettings()
	good.Mode = ChatModeBlock
	if _, _, _, err := s2.Update(good); err == nil {
		t.Error("no error for unwritable path")
	}
	if s2.Settings().Mode != ChatModeCensor {
		t.Error("settings changed despite failed save")
	}
}

func TestChatModerationStoreSettingsIsCopy(t *testing.T) {
	s := NewChatModerationStore(filepath.Join(t.TempDir(), "c.yaml"))
	in := DefaultChatModerationSettings()
	in.Words = []string{"muppet"}
	if _, _, _, err := s.Update(in); err != nil {
		t.Fatal(err)
	}
	got := s.Settings()
	got.Words[0] = "changed"
	if s.Settings().Words[0] != "muppet" {
		t.Error("Settings() shares its slice with the store")
	}
}

func TestChatModerationStoreConcurrent(t *testing.T) {
	s := NewChatModerationStore(filepath.Join(t.TempDir(), "chat_moderation.yaml"))
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				res := s.Filter().Check("you shit, see example.com")
				if res.Status == ChatStatusOK {
					t.Error("message passed unfiltered")
					return
				}
				_ = s.Settings()
				_ = s.Filter().UsernameBlocked("muppet")
			}
		}()
	}
	for i := 0; i < 20; i++ {
		in := DefaultChatModerationSettings()
		if i%2 == 0 {
			in.Mode = ChatModeBlock
			in.Words = []string{"muppet"}
		}
		if _, _, _, err := s.Update(in); err != nil {
			t.Error(err)
		}
	}
	close(stop)
	wg.Wait()
}
