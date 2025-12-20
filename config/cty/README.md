# CTY.DAT - Country Files

This directory should contain the `cty.dat` file for DXCC country lookup.

## Obtaining CTY.DAT

The CTY.DAT file is maintained by Jim Reisert AD1C and can be downloaded from:

**Primary Source:**
- http://www.country-files.com/cty/

**Direct Download:**
- http://www.country-files.com/cty/cty.dat

## Installation

1. Download the latest `cty.dat` file from the link above
2. Place it in this directory: `config/cty/cty.dat`
3. Restart ka9q_ubersdr to load the database

## File Format

The CTY.DAT file uses the CT Version 9 format with:
- Entity definitions (country name, CQ zone, ITU zone, continent, lat/lon, time offset, primary prefix)
- Prefix aliases with optional override modifiers:
  - `=` prefix for exact match
  - `(#)` CQ zone override
  - `[#]` ITU zone override
  - `<#/#>` lat/lon override
  - `{aa}` continent override
  - `~#~` time offset override

## License

The CTY.DAT file is copyrighted by Jim Reisert AD1C. Please respect the license terms when using this file.

## Updates

The CTY.DAT file is updated regularly to reflect changes in DXCC entities and prefixes. Check the website periodically for updates.