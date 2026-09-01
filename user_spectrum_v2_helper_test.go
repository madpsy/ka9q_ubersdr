package main

import "fmt"

func sprintf(f string, a ...interface{}) string { return fmt.Sprintf(f, a...) }
