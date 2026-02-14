#!/usr/bin/env python3
"""
Extract LDPC matrices from KiwiSDR constants.c and convert to Go format
"""

# Read the C constants file
with open('constants.c.ref', 'r') as f:
    lines = f.readlines()

output = []
output.append("package ft8")
output.append("")
output.append("/*")
output.append(" * LDPC Tables for FT8/FT4")
output.append(" * Extracted from ft8_lib by Karlis Goba (YL3JG)")
output.append(" * These matrices define the (174,91) LDPC code used in FT8/FT4")
output.append(" */")
output.append("")

# Find and extract Nm matrix (lines 119-203)
output.append("// LDPC_Nm: Parity check matrix")
output.append("// Each row defines one parity check (which codeword bits must XOR to zero)")
output.append("// 83 rows (parity checks) × 7 columns (bit indices, 1-origin, 0=unused)")
output.append("var LDPC_Nm = [FTX_LDPC_M][7]uint8{")
in_nm = False
nm_count = 0
for i, line in enumerate(lines):
    if 'kFTX_LDPC_Nm' in line and '=' in line:
        in_nm = True
        continue
    if in_nm:
        if '};' in line:
            break
        if '{' in line:
            # Extract the row data
            row = line.strip().rstrip(',')
            output.append(f"\t{row},")
            nm_count += 1
output.append("}")
output.append("")

# Find and extract Mn matrix (lines 208-383)
output.append("// LDPC_Mn: Inverse matrix")
output.append("// Each row lists which 3 parity checks involve this codeword bit")
output.append("// 174 rows (codeword bits) × 3 columns (check indices, 1-origin)")
output.append("var LDPC_Mn = [FTX_LDPC_N][3]uint8{")
in_mn = False
mn_count = 0
for i, line in enumerate(lines):
    if 'kFTX_LDPC_Mn' in line and '=' in line:
        in_mn = True
        continue
    if in_mn:
        if '};' in line:
            break
        if '{' in line:
            row = line.strip().rstrip(',')
            output.append(f"\t{row},")
            mn_count += 1
output.append("}")
output.append("")

# Find and extract Num_rows array (lines 385-391)
output.append("// LDPC_Num_rows: Number of bits participating in each parity check")
output.append("// 83 elements (values are 6 or 7)")
output.append("var LDPC_Num_rows = [FTX_LDPC_M]uint8{")
in_numrows = False
numrows_data = []
for i, line in enumerate(lines):
    if 'kFTX_LDPC_Num_rows' in line and '=' in line:
        in_numrows = True
        continue
    if in_numrows:
        if '};' in line:
            break
        numrows_data.append(line.strip())
output.append('\t' + ' '.join(numrows_data).rstrip(','))
output.append("}")

# Write output
with open('ldpc_tables.go', 'w') as f:
    f.write('\n'.join(output))
    f.write('\n')

print("✅ Created ldpc_tables.go")
print(f"   - LDPC_Nm: {nm_count} rows")
print(f"   - LDPC_Mn: {mn_count} rows")
print(f"   - LDPC_Num_rows: 83 elements")
