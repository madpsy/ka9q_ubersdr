#!/bin/bash

pyinstaller --onefile radio_client.py --icon=ubersdr.ico --hidden-import=PIL._tkinter_finder
