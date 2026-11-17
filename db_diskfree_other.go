//go:build !unix

package main

import "errors"

// dbDiskFree is unknown on this platform; callers that need it skip whatever
// it was guarding.
func dbDiskFree(string) (int64, error) {
	return 0, errors.New("free disk space is not available on this platform")
}
