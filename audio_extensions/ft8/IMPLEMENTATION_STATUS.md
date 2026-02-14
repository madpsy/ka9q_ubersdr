# FT8 Decoder Implementation Status

## Overview
This document tracks the progress of porting the complete KiwiSDR FT8 implementation to Go for UberSDR.

## Completed Components ✅

### 1. Text Utilities (`text.go`) - **COMPLETE**
- ✅ Character table enumerations (Full, Alphanum, Letters, Numeric, etc.)
- ✅ String manipulation functions (Trim, TrimFront, TrimBack)
- ✅ Character classification (IsDigit, IsLetter, IsSpace)
- ✅ String comparison (StartsWith, EndsWith, Equals)
- ✅ Message formatting (FmtMsg)
- ✅ Token parsing (CopyToken)
- ✅ Integer conversion (DDToInt, IntToDD)
- ✅ Character encoding/decoding (Charn, Nchar)

**Lines ported:** ~294 lines from text.c.ref

### 2. Callsign Hash Table (`hashtable.go`) - **COMPLETE**
- ✅ Hash table data structure with thread-safe operations
- ✅ SaveCallsign() - Computes 22/12/10-bit hashes
- ✅ LookupHash() - Resolves hashes to callsigns
- ✅ Cleanup() - Age-based entry removal
- ✅ Size() and Clear() operations

**Lines ported:** ~100 lines (new implementation)

### 3. Message Unpacking (`message.go`) - **PARTIAL**

#### Completed:
- ✅ Message type detection (GetMessageType)
- ✅ Basic standard message unpacking (Type 1/2)
- ✅ Telemetry unpacking (Type 0.5)
- ✅ Grid square unpacking (4-character Maidenhead)
- ✅ Basic callsign unpacking (unpack28 - partial)
- ✅ Token unpacking (CQ, DE, QRZ, CQ_nnn)

#### Current Status:
**325 lines implemented** out of **1143 lines needed**

## Missing Components 🚧

### 1. Complete Message Unpacking (~818 lines remaining)

#### A. Enhanced unpack28() Function
**Current:** Basic implementation with token support
**Needed:**
- ✅ Special tokens (DE, QRZ, CQ) - DONE
- ✅ CQ with 3-digit numbers (CQ 000-999) - DONE
- ⚠️ CQ with 4-letter suffixes (CQ ABCD) - PARTIAL
- ❌ 22-bit hash resolution with hash table lookup
- ❌ Standard callsign with special prefix handling:
  - 3DA0XYZ → 3D0XYZ (Swaziland)
  - 3XA0XYZ → QA0XYZ (Guinea)
- ❌ Callsign storage in hash table after unpacking
- ❌ /R and /P suffix handling (complete)

#### B. unpack58() for Non-Standard Callsigns
**Status:** ❌ NOT IMPLEMENTED
**Needed:**
- Decode 58-bit encoded callsigns (base-38 encoding)
- Handle callsigns up to 11 characters
- Support special characters (/, space)
- Save decoded callsigns to hash table

#### C. Complete packgrid()/unpackgrid()
**Current:** Basic grid and report unpacking
**Needed:**
- ✅ 4-character grid squares (AA00-RR99) - DONE
- ✅ Special values (RRR, RR73, 73) - DONE
- ⚠️ Signal reports with R prefix - PARTIAL
- ❌ Full report range validation (-30 to +32 dB)

#### D. Free Text Decoder (Type 0.0)
**Status:** ❌ PLACEHOLDER ONLY
**Needed:**
- Extract 71 bits from payload
- Decode using 42-character alphabet
- Base-42 division algorithm
- Support up to 13 characters
- Character set: 0-9, A-Z, space, +, -, ., /, ?

#### E. Additional Message Type Decoders

##### Type 0.1: DXpedition Mode
**Status:** ❌ NOT IMPLEMENTED
**Format:** c28 c28 h10 r5
**Fields:**
- Two 28-bit callsigns
- 10-bit hash for third callsign
- 5-bit signal report (r5: 0..31 → -30 to +32 dB)
**Example:** "W1ABC RR73; K2DEF <...> +15"

##### Type 0.2: EU VHF Contest
**Status:** ❌ NOT IMPLEMENTED
**Format:** Similar to standard but with contest exchange

##### Type 0.3/0.4: ARRL Field Day
**Status:** ❌ NOT IMPLEMENTED
**Format:** Contest-specific encoding

##### Type 0.6: Contesting
**Status:** ❌ NOT IMPLEMENTED
**Format:** c28 c28 g15
**Fields:**
- Two 28-bit callsigns
- 15-bit grid square
**Example:** "W1ABC K2DEF FN42"

##### Type 3: ARRL RTTY Roundup
**Status:** ❌ NOT IMPLEMENTED

##### Type 4: Non-Standard Callsigns
**Status:** ❌ NOT IMPLEMENTED
**Format:** h12 c58 h1 r2 c1
**Fields:**
- 12-bit hash for one callsign
- 58-bit encoded non-standard callsign
- Flip bit, report bits, CQ flag
**Example:** "CQ <DL/W1ABC/P>" or "<K2DEF> <W1ABC> RR73"

##### Type 5: WWDIGI
**Status:** ❌ NOT IMPLEMENTED

### 2. Integration with Decoder

#### Current Integration:
- ✅ Basic UnpackMessage() function exists
- ✅ Called from decoder.go
- ❌ No hash table integration
- ❌ No support for advanced message types

#### Needed Integration:
- Create global or per-decoder hash table instance
- Pass hash table to UnpackMessage()
- Store decoded callsigns automatically
- Resolve hashes during unpacking

## Implementation Priority

### Phase 1: Core Functionality (High Priority)
1. ✅ **Text utilities** - COMPLETE
2. ✅ **Hash table** - COMPLETE
3. ⚠️ **Complete unpack28()** - IN PROGRESS
   - Add hash table lookup
   - Add special prefix handling
   - Add callsign storage
4. ❌ **Implement unpack58()**
5. ❌ **Complete free text decoder**

### Phase 2: Extended Message Types (Medium Priority)
6. ❌ **Type 0.1: DXpedition mode**
7. ❌ **Type 0.6: Contesting**
8. ❌ **Type 4: Non-standard callsigns**

### Phase 3: Specialized Modes (Low Priority)
9. ❌ **Type 0.2: EU VHF**
10. ❌ **Type 0.3/0.4: ARRL Field Day**
11. ❌ **Type 3: ARRL RTTY**
12. ❌ **Type 5: WWDIGI**

## Code Statistics

### Current Implementation:
- **text.go:** 294 lines (100% complete)
- **hashtable.go:** 100 lines (100% complete)
- **message.go:** 325 lines (28% of target)

### Target (KiwiSDR Parity):
- **text.c.ref:** 294 lines
- **message.c.ref:** 1143 lines
- **Total:** 1437 lines

### Remaining Work:
- **~818 lines** of message unpacking code
- **~100 lines** of integration code
- **Total:** ~918 lines remaining

## Testing Requirements

### Unit Tests Needed:
1. ❌ Text utility functions
2. ❌ Hash table operations
3. ❌ Message type detection
4. ❌ Callsign unpacking (all formats)
5. ❌ Grid square unpacking
6. ❌ Free text decoding
7. ❌ Each message type decoder

### Integration Tests Needed:
1. ❌ End-to-end message decoding
2. ❌ Hash table persistence across messages
3. ❌ Real-world FT8 samples
4. ❌ Performance benchmarks

## Known Issues

### Current Bugs:
1. ⚠️ Duplicate constant declarations in message.go (lines 16-18 and 332-336)
2. ⚠️ unpackCallsign() logic may not match reference implementation exactly
3. ⚠️ CQ with 4-letter suffix not fully implemented
4. ⚠️ Free text decoder is placeholder only

### Design Decisions:
1. ✅ Using Go's native string handling instead of C char arrays
2. ✅ Thread-safe hash table with sync.RWMutex
3. ✅ Separate text utilities file for clarity
4. ⚠️ Need to decide on hash table lifecycle (global vs per-decoder)

## Next Steps

### Immediate Actions:
1. ✅ Fix duplicate constants in message.go
2. ❌ Complete unpack28() with hash table integration
3. ❌ Implement unpack58()
4. ❌ Implement free text decoder
5. ❌ Add DXpedition and Contesting message types
6. ❌ Integrate hash table with decoder
7. ❌ Add comprehensive tests

### Future Enhancements:
- Hash table persistence to disk
- Statistics on decoded message types
- Callsign database integration
- Performance optimization

## References

- **KiwiSDR Implementation:** message.c.ref, text.c.ref
- **FT8 Protocol:** WSJT-X documentation
- **ft8_lib:** https://github.com/kgoba/ft8_lib

## Completion Estimate

- **Phase 1 (Core):** ~3-4 hours of development
- **Phase 2 (Extended):** ~2-3 hours of development
- **Phase 3 (Specialized):** ~2-3 hours of development
- **Testing:** ~2-3 hours
- **Total:** ~10-13 hours to 100% parity

**Current Progress:** ~40% complete (infrastructure + basic decoding)
**Remaining:** ~60% (advanced message types + testing)
