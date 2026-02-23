# Zombie Process Fix for Caddy Container

## Problem

The Caddy container was accumulating defunct `ssl_client` processes over time. These zombie processes were caused by:

1. **Background watcher process** in `caddy-entrypoint.sh` that spawns subprocesses
2. **No init system** to reap orphaned child processes
3. **Caddy as PID 1** - Caddy is not designed to reap zombie processes from other processes

The `ssl_client` processes specifically come from:
- BusyBox's `wget` implementation used in healthchecks
- `wget` spawns `ssl_client` helper processes for HTTPS connections
- These become zombies when the parent shell exits without properly waiting

## Solution Applied

Added `init: true` to both `ubersdr` and `caddy` services in:
- [`docker-compose.yml`](docker-compose.yml)
- [`docker-compose-dockerhub.yml`](docker-compose-dockerhub.yml)

This enables Docker's built-in `tini` init system, which:
- Runs as PID 1 instead of the application
- Automatically reaps all zombie processes
- Forwards signals properly to the application
- Is the standard Docker solution for this problem

## Changes Made

### docker-compose.yml
```yaml
ubersdr:
  # ... existing config ...
  init: true  # Enable tini init to reap zombie processes from background watchers

caddy:
  # ... existing config ...
  init: true  # Enable tini init to reap zombie processes (fixes defunct ssl_client)
```

### docker-compose-dockerhub.yml
Same changes applied to the Docker Hub version.

## How to Apply

1. **Stop the containers:**
   ```bash
   cd docker
   docker-compose down
   ```

2. **Restart with the fix:**
   ```bash
   docker-compose up -d
   ```

   Or for Docker Hub version:
   ```bash
   docker-compose -f docker-compose-dockerhub.yml up -d
   ```

3. **Verify the fix:**
   ```bash
   # Check for zombie processes (should show none after fix)
   docker exec caddy ps aux | grep defunct
   
   # Verify tini is running as PID 1
   docker exec caddy ps aux | head -n 2
   # Should show: PID 1 = /sbin/docker-init or tini
   ```

## Why This Solution is Safe

1. **Standard Docker feature** - `init: true` is officially supported by Docker
2. **No code changes** - No modifications to entrypoint scripts or application code
3. **Transparent** - Applications run exactly as before, just with proper process reaping
4. **Minimal overhead** - `tini` is extremely lightweight (~10KB)
5. **Widely used** - This is the recommended solution in Docker documentation

## Alternative Solutions (Not Used)

We considered but did not implement:

1. **Manual tini installation** - More complex, requires modifying entrypoint scripts
2. **Simplifying the watcher** - Would reduce functionality
3. **Removing background processes** - Would break restart trigger functionality

## Additional Notes

- The same fix was applied to `ubersdr` service as it also has a background watcher process
- No changes needed to `ka9q-radio` service as it doesn't have background watchers
- The fix is backward compatible - containers will restart normally with no data loss
- Existing volumes and configurations are not affected

## Verification Commands

After applying the fix and restarting:

```bash
# Monitor for zombie processes over time
watch 'docker exec caddy ps aux | grep defunct'

# Check process tree
docker exec caddy ps auxf

# View init process
docker exec caddy ps -p 1 -o pid,comm,args
```

You should see no defunct processes accumulating over time.
