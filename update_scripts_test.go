package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These tests run the real install-hub.sh and manage_addons.sh with sudo, docker
// and curl replaced by stubs, so they never touch the machine they run on.
//
// They guard against two overlapping updates, which on elitedesk (2026-11-05)
// left the navtex and ntp addons down. The cron job started a second run because
// the first run's "apt upgrade" restarted Docker, which restarted the old UberSDR
// container, whose startup version check rewrote the trigger file.

// updateHarness is a fake home directory and a PATH of stub commands. Every stub
// appends its command line to calls.log.
type updateHarness struct {
	t    *testing.T
	home string
	bin  string
	log  string
}

func newUpdateHarness(t *testing.T) *updateHarness {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	root := t.TempDir()
	h := &updateHarness{
		t:    t,
		home: filepath.Join(root, "home"),
		bin:  filepath.Join(root, "bin"),
		log:  filepath.Join(root, "calls.log"),
	}
	for _, dir := range []string{h.home, h.bin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Nothing may reach the real sudo or docker: the addon manager reads the admin
	// password with sudo, and these commands act on the machine running the tests.
	h.stub("sudo", "exit 1")
	h.stub("docker", "exit 1")
	// install-hub.sh finds its home directory through getent, so without this
	// stub the lock would be taken in the real home of whoever runs the tests.
	h.stub("getent", fmt.Sprintf(`echo "tester:x:1000:1000::%s:/bin/bash"`, h.home))
	return h
}

// stub creates a command on the harness PATH that logs its arguments, then runs body.
func (h *updateHarness) stub(name, body string) {
	h.t.Helper()
	script := fmt.Sprintf("#!/bin/bash\necho %q \"$*\" >> %q\n%s\n", name, h.log, body)
	if err := os.WriteFile(filepath.Join(h.bin, name), []byte(script), 0o755); err != nil {
		h.t.Fatal(err)
	}
}

func (h *updateHarness) writeFile(rel, content string) string {
	h.t.Helper()
	path := filepath.Join(h.home, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		h.t.Fatal(err)
	}
	return path
}

func (h *updateHarness) calls() string {
	h.t.Helper()
	data, err := os.ReadFile(h.log)
	if err != nil && !os.IsNotExist(err) {
		h.t.Fatal(err)
	}
	return string(data)
}

func (h *updateHarness) command(args ...string) *exec.Cmd {
	cmd := exec.Command("bash", args...)
	cmd.Env = []string{
		"HOME=" + h.home,
		"USER=tester",
		"PATH=" + h.bin + ":/usr/bin:/bin",
	}
	return cmd
}

// startHub starts install-hub.sh the way the cron job does: piped in on stdin.
func (h *updateHarness) startHub(output *bytes.Buffer) *exec.Cmd {
	h.t.Helper()
	script, err := os.ReadFile("install-hub.sh")
	if err != nil {
		h.t.Fatal(err)
	}
	cmd := h.command("-s", "--")
	cmd.Stdin = bytes.NewReader(script)
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		h.t.Fatal(err)
	}
	return cmd
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

// The scenario that broke the addons: a second run starts while the first is busy.
func TestInstallHubSecondRunExitsWhileFirstIsRunning(t *testing.T) {
	h := newUpdateHarness(t)
	h.writeFile("ubersdr/installed", "")

	inSudo := filepath.Join(h.home, "first-run-reached-sudo")
	release := filepath.Join(h.home, "release-first-run")
	// The first command the script runs after the lock is "sudo apt update". Park
	// the first run there, then fail so that it exits once released. The wait is
	// bounded so that a stub can never outlive a test run that gets killed.
	h.stub("sudo", fmt.Sprintf(`touch %q; for i in {1..3000}; do [ -e %q ] && break; sleep 0.01; done; exit 1`, inSudo, release))

	var firstOutput bytes.Buffer
	first := h.startHub(&firstOutput)
	defer func() {
		_ = os.WriteFile(release, nil, 0o644)
		_ = first.Wait()
	}()
	waitForFile(t, inSudo)

	var secondOutput bytes.Buffer
	second := h.startHub(&secondOutput)
	done := make(chan error, 1)
	go func() { done <- second.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second run should exit cleanly: %v\n%s", err, secondOutput.String())
		}
	case <-time.After(10 * time.Second):
		// Without a lock it parks in the sudo stub alongside the first run.
		_ = os.WriteFile(release, nil, 0o644)
		<-done
		t.Fatalf("second run overlapped the first instead of exiting:\n%s", secondOutput.String())
	}
	if !strings.Contains(secondOutput.String(), "already running") {
		t.Errorf("second run did not report the running update:\n%s", secondOutput.String())
	}
	if strings.Contains(secondOutput.String(), "Installing dependencies") {
		t.Errorf("second run went on to do work:\n%s", secondOutput.String())
	}
	if n := strings.Count(h.calls(), "sudo apt update"); n != 1 {
		t.Errorf("sudo apt update ran %d times, want only the first run's 1:\n%s", n, h.calls())
	}

	// The lock must not outlive the run that took it, or updates would stop forever.
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := first.Wait(); err == nil {
		t.Fatal("first run should have failed at the stubbed sudo")
	}
	var thirdOutput bytes.Buffer
	third := h.startHub(&thirdOutput)
	_ = third.Wait()
	if !strings.Contains(thirdOutput.String(), "Installing dependencies") {
		t.Errorf("run after the first finished was still locked out:\n%s", thirdOutput.String())
	}
}

// Failing to take the lock must not stop updates from working at all.
func TestInstallHubContinuesWhenLockCannotBeTaken(t *testing.T) {
	h := newUpdateHarness(t)
	h.writeFile("ubersdr/installed", "")
	h.stub("sudo", "exit 1")
	// A directory in the lock file's place makes it impossible to open.
	if err := os.Mkdir(filepath.Join(h.home, ".ubersdr-update.lock"), 0o755); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	_ = h.startHub(&output).Wait()
	if !strings.Contains(output.String(), "could not take the update lock") {
		t.Errorf("missing warning:\n%s", output.String())
	}
	if !strings.Contains(output.String(), "Installing dependencies") {
		t.Errorf("update did not continue without the lock:\n%s", output.String())
	}
}

// The trigger written by the old container must be gone before the new one starts.
func TestInstallHubClearsTriggerAfterOldContainersStop(t *testing.T) {
	data, err := os.ReadFile("install-hub.sh")
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	lines := []string{
		`docker compose -f docker-compose.yml down`,
		"\n        clear_update_trigger\n",
		`docker compose -f docker-compose.yml up -d`,
	}
	previous := -1
	for _, line := range lines {
		at := strings.Index(script, line)
		if at < 0 {
			t.Fatalf("install-hub.sh no longer contains %q", line)
		}
		if at <= previous {
			t.Errorf("%q is out of order: want compose down, clear trigger, compose up", line)
		}
		previous = at
	}

	// Run the function itself, cut from the script, against a real file.
	h := newUpdateHarness(t)
	trigger := h.writeFile("ubersdr/updater/latest", "0.1.68")
	h.stub("sudo", `exec "$@"`)
	start := strings.Index(script, "clear_update_trigger() {")
	if start < 0 {
		t.Fatal("clear_update_trigger not found")
	}
	end := strings.Index(script[start:], "\n}\n")
	if end < 0 {
		t.Fatal("end of clear_update_trigger not found")
	}
	fn := script[start : start+end+3]
	cmd := h.command("-c", "set -e\nACTUAL_HOME="+h.home+"\n"+fn+"clear_update_trigger\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("clear_update_trigger failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(trigger); !os.IsNotExist(err) {
		t.Errorf("trigger file still exists after clear_update_trigger (stat error: %v)", err)
	}
}

// Child scripts must not inherit the lock, or a process they leave behind would
// block every later update.
func TestInstallHubDoesNotPassLockToChildren(t *testing.T) {
	data, err := os.ReadFile("install-hub.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{
		`bash "$ADDON_MANAGER" --update-all 9>&-`,
		`bash "$CWSKIMMER_UPDATER" 9>&-`,
	} {
		if !strings.Contains(string(data), line) {
			t.Errorf("install-hub.sh does not run %q", line)
		}
	}
}

// addonUpdate runs the real manage_addons.sh --update-all for one addon "navtex",
// with `docker ps -a` reporting the given "<name> <state>" lines.
func addonUpdate(t *testing.T, containers string, running bool) (*updateHarness, string, error) {
	t.Helper()
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("jq not available")
	}
	h := newUpdateHarness(t)
	h.writeFile("ubersdr/navtex/docker-compose.yml", "services: {}\n")

	// manage_addons.sh reads addons.json from beside itself, so run a copy.
	script, err := os.ReadFile("manage_addons.sh")
	if err != nil {
		t.Fatal(err)
	}
	manager := h.writeFile("manager/manage_addons.sh", string(script))
	h.writeFile("manager/addons.json", `{"addons":[{"name":"navtex","port":6090,
		"install_script_url":"https://example.invalid/navtex/install.sh"}]}`)

	runningID := ""
	if running {
		runningID = "abc123"
	}
	h.stub("docker", fmt.Sprintf(`
case "$*" in
  "ps -a "*) printf '%%b' %q ;;
  "compose "*|"ps -q "*) echo %q ;;
esac
exit 0`, containers, runningID))
	// Serves the install script, and fails everything else (the admin API).
	h.stub("curl", `
case "$*" in
  *example.invalid*) echo 'echo install-script-ran' ;;
  *) exit 1 ;;
esac`)

	cmd := h.command(manager, "--update-all")
	out, runErr := cmd.CombinedOutput()
	return h, string(out), runErr
}

// The state navtex and ntp were left in: nothing running, one never-started leftover.
func TestUpdateAllRepairsAddonLeftBrokenByInterruptedUpdate(t *testing.T) {
	h, out, err := addonUpdate(t, "b7ed26716644_navtex created\n", false)
	if err != nil {
		t.Fatalf("update failed: %v\n%s", err, out)
	}
	calls := h.calls()
	rm := strings.Index(calls, "docker rm b7ed26716644_navtex")
	if rm < 0 {
		t.Fatalf("leftover was not removed:\n%s", calls)
	}
	if install := strings.Index(calls, "curl -fsSL https://example.invalid"); install < rm {
		t.Errorf("leftover must be removed before the install script runs:\n%s", calls)
	}
	if !strings.Contains(out, "install-script-ran") {
		t.Errorf("install script did not run:\n%s", out)
	}
	if !strings.Contains(calls, "label=com.docker.compose.project.working_dir="+h.home+"/ubersdr/navtex") {
		t.Errorf("containers must be looked up by this addon's compose project:\n%s", calls)
	}
	// It is broken, not deliberately stopped, so it has to end up running.
	if strings.Contains(out, "left stopped") || strings.Contains(out, "stopping it again") {
		t.Errorf("repaired addon was stopped again:\n%s", out)
	}
}

func TestUpdateAllKeepsContainersThatAreNotLeftovers(t *testing.T) {
	tests := []struct {
		name       string
		containers string
	}{
		{"no containers", ""},
		{"normal running container", "navtex running\n"},
		{"normal stopped container", "navtex exited\n"},
		{"never-started container with the normal name", "navtex created\n"},
		{"temporary name but running", "b7ed26716644_navtex running\n"},
		{"temporary name but restarting", "b7ed26716644_navtex restarting\n"},
		{"name only resembles the temporary form", "b7ed2671_navtex created\n"},
		{"prefix is not hexadecimal", "zzzzzzzzzzzz_navtex created\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, out, err := addonUpdate(t, tt.containers, true)
			if err != nil {
				t.Fatalf("update failed: %v\n%s", err, out)
			}
			if strings.Contains(h.calls(), "docker rm") {
				t.Errorf("removed a container it should have kept:\n%s", h.calls())
			}
			if !strings.Contains(out, "install-script-ran") {
				t.Errorf("install script did not run:\n%s", out)
			}
		})
	}
}

// An addon the operator stopped must stay stopped when there is nothing to repair.
func TestUpdateAllLeavesStoppedAddonStopped(t *testing.T) {
	_, out, err := addonUpdate(t, "navtex exited\n", false)
	if err != nil {
		t.Fatalf("update failed: %v\n%s", err, out)
	}
	if !strings.Contains(out, "left stopped") {
		t.Errorf("stopped addon was not left stopped:\n%s", out)
	}
}
