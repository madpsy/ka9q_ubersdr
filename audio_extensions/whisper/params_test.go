package whisper

import "testing"

// language is the LibreTranslate *target*, forwarded verbatim as the "target"
// field of a request per transcription segment — to a possibly-shared upstream.
// It used to be taken unchecked and unbounded, so a multi-megabyte attach
// string became a multi-megabyte POST body repeated for the life of the
// session. It is now held to the same shape as asr_language.
func TestTargetLanguageIsValidated(t *testing.T) {
	base := AudioExtensionParams{SampleRate: 16000, Channels: 1, BitsPerSample: 16}

	bad := []string{
		"en; DROP",
		"not a language code",
		string(make([]byte, 1024)),
		"e",
		"toolongcode",
		"en-",
	}
	for _, v := range bad {
		if _, err := NewWhisperExtension(base, map[string]interface{}{"language": v}); err == nil {
			label := v
			if len(label) > 24 {
				label = label[:24] + "…"
			}
			t.Errorf("language %q was accepted, want refused", label)
		}
	}

	// Everything the interface offers is a plain ISO-639 code, optionally with
	// a region; none of it may be refused.
	for _, v := range []string{"en", "de", "pt", "zh", "pt-BR", "zt"} {
		_, err := NewWhisperExtension(base, map[string]interface{}{"language": v})
		if err != nil && err.Error() != "" {
			// Construction can still fail for unrelated reasons (no server
			// configured); only a complaint about the language itself is a bug.
			if containsLanguageComplaint(err.Error()) {
				t.Errorf("language %q refused: %v", v, err)
			}
		}
	}
}

func containsLanguageComplaint(s string) bool {
	for i := 0; i+len("invalid language") <= len(s); i++ {
		if s[i:i+len("invalid language")] == "invalid language" {
			return true
		}
	}
	return false
}
