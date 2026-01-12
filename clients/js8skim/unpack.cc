//
// unpack 87-bit JS8 messages
//
// Robert Morris, AB1HL
//

#include <string>
#include <vector>
#include <stdio.h>
#include <assert.h>
#include <string.h>

// Embedded words.txt data
#include "words_embedded.h"

std::vector<std::string> words;

//
// load the (s,c)-dense compression words from embedded data
// from JS8Call's jsc_list.cpp
//
void
load_words()
{
  if(words.size() > 0)
    return;

  // Parse embedded words data
  std::string current_word;
  for(unsigned int i = 0; i < words_txt_len; i++){
    char c = (char)words_txt[i];
    if(c == '\n'){
      if(current_word.size() > 0){
        words.push_back(current_word);
        current_word.clear();
      }
    } else {
      current_word.push_back(c);
    }
  }
  
  // Add last word if there's no trailing newline
  if(current_word.size() > 0){
    words.push_back(current_word);
  }
}

//
// a87[] holds the entire 87 decoded bits.
// really 72, omitting 12-bit CRC and 3 unused bits.
// first two are 1, 1.
//
std::string
unpack_dense(const int a87[87])
{

  //
  // (s,c)-dense compression.
  // a sequence of 4-bit nibbles.
  // combine the nibbles to produce indices into words[].
  // from JS8Call's jsc.cpp
  //

  int s = 7;
  int c = 9;

  int base[8];
  base[0] = 0;
  base[1] = s;
  base[2] = base[1] + s*c;
  base[3] = base[2] + s*c*c;
  base[4] = base[3] + s*c*c*c;
  base[5] = base[4] + s*c*c*c*c;
  base[6] = base[5] + s*c*c*c*c*c;
  base[7] = base[6] + s*c*c*c*c*c*c;

  std::string ret;

  int i = 2; // a87[i]
  int index = 0;
  int k = 0; // nibble number in this index.
  while(i + 4 <= 72){
    int nibble =
      (a87[i+0] << 3) |
      (a87[i+1] << 2) |
      (a87[i+2] << 1) |
      (a87[i+3] << 0);

    i += 4;
      
    if(nibble >= s){
      // not the last nibble of the index.
      index = index*c + nibble - s;
      k++;
    } else {
      // last nibble of the index.
      index = index*s + nibble + base[k];

      if(index < 0 || index >= words.size()){
        fprintf(stderr, "unpack_dense: invalid index %d (words.size=%d), inserting [ERR]\n",
                index, (int)words.size());
        ret = ret + "[ERR]";
      } else {
        ret = ret + words[index];
      }

      if(a87[i]){
        ret = ret + " ";
      }
      i++;

      index = 0;
      k = 0;
    }
  }

  if(a87[73])
    ret += "<>";

  return ret;
}

//
// from JS8Call's varicode.cpp
//
struct htht {
  const char *a;
  const char *b;
};
struct htht ht[] = {
  { " ", "01" },
  { "E", "100" },
  { "T", "1101" },
  { "A", "0011" },
  { "O", "11111" },
  { "I", "11100" },
  { "N", "10111" },
  { "S", "10100" },
  { "H", "00011" },
  { "R", "00000" },
  { "D", "111011" },
  { "L", "110011" },
  { "C", "110001" },
  { "U", "101101" },
  { "M", "101011" },
  { "W", "001011" },
  { "F", "001001" },
  { "G", "000101" },
  { "Y", "000011" },
  { "P", "1111011" },
  { "B", "1111001" },
  { ".", "1110100" },
  { "V", "1100101" },
  { "K", "1100100" },
  { "-", "1100001" },
  { "+", "1100000" },
  { "?", "1011001" },
  { "!", "1011000" },
  { "\"", "1010101" },
  { "X", "1010100" },
  { "0", "0010101" },
  { "J", "0010100" },
  { "1", "0010001" },
  { "Q", "0010000" },
  { "2", "0001001" },
  { "Z", "0001000" },
  { "3", "0000101" },
  { "5", "0000100" },
  { "4", "11110101" },
  { "9", "11110100" },
  { "8", "11110001" },
  { "6", "11110000" },
  { "7", "11101011" },
  { "/", "11101010" },
  { 0, 0 }
};

// padding is often needed; the receiver looks
// back from the end for the last 0-bit,
// and treats it and the 1's after it as padding.
std::string
unpack_huffman(const int a87[87])
{
  int end = 71;
  while(end > 0 && a87[end] != 0)
    end -= 1;
  
  std::string ret;
  int i = 2;
  while(i < end){
    int j;
    for(j = 0; ht[j].a; j++){
      int k;
      for(k = 0; ht[j].b[k] && i + k < 72; k++){
        if(ht[j].b[k] == '1'){
          if(a87[i+k] != 1)
            break;
        } else {
          if(a87[i+k] != 0)
            break;
        }
      }
      if(ht[j].b[k] == '\0'){
        break;
      }
    }
    if(ht[j].a){
      ret += ht[j].a;
      i += strlen(ht[j].b);
    } else {
      ret += "?";
      i++;
    }
  }
  if(a87[73])
    ret += "<>"; // end of the over
  return ret;
}

//
// extract a run of decoded bits, turn into an int,
// most significant bit first.
//
unsigned long long
un(const int a87[87], int start, int n)
{
  assert(n > 0 && n <= 64 && start + n <= 72);
  unsigned long long x = 0;
  for(int i = 0; i < n; i++){
    x <<= 1;
    x += a87[start+i];
  }
  return x;
}

//
// given a 28-bit integer, return a call sign.
//
std::string
unpack_call(unsigned int x)
{
  char s[6+1];

  char c1[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ ";
  char c2[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  char c3[] = "0123456789";
  char c4[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

  s[6] = '\0';

  s[5] = c4[x % 27];
  x /= 27;

  s[4] = c4[x % 27];
  x /= 27;

  s[3] = c4[x % 27];
  x /= 27;

  s[2] = c3[x % 10];
  x /= 10;

  s[1] = c2[x % 36];
  x /= 36;

  if(x < sizeof(c1)-1){
    s[0] = c1[x];
  } else {
    s[0] = '?';
  }

  std::string ss(s);

  // trim white space
  while(ss.size() > 0 && ss[0] == ' '){
    ss.erase(0, 1);
  }
  while(ss.size() > 0 && ss[ss.size()-1] == ' '){
    ss.erase(ss.size()-1, 1);
  }

  return ss;
}

//
// directed_cmds[] from JS8Call's varicode.cpp
//
const char *directed_cmds[] = {
  "SNR?",        // query snr
  "DIT DIT",     // unused
  "NACK",        // negative acknowledge
  "HEARING?",    // query station calls heard
  "GRID?",       // query grid
  ">",           // relay message
  "STATUS?",     // query idle message
  "STATUS",      // this is my status
  "HEARING",     // these are the stations i'm hearing
  "MSG",         // this is a complete message
  "MSG TO:",     // store message at a station
  "QUERY",       // generic query
  "QUERY MSGS?", // do you have any stored messages?
  "QUERY CALL",  // can you transmit a ping to callsign?
  "RESERVED",    // reserved
  "GRID",        // this is my current grid locator
  "INFO?",       // what is your info message?
  "INFO",        // this is my info message
  "FB",          // fine business
  "HW CPY?",     // how do you copy?
  "SK",          // end of contact
  "RR",          // roger roger
  "QSL?",    // do you copy?
  "QSL",     // i copy
  "CMD",     // command
  "SNR",     // seen a station at the provided snr
  "NO",      // negative confirm
  "YES",     // confirm
  "73",      // best regards, end of contact
  "ACK",     // acknowledge
  "AGN?",    // repeat message
  "TEXT",        // 31: send freetext
};

//
//  3 bits at  0: type=011
// 28 bits at  3: from callsign
// 28 bits at 31: to callsign
//  5 bits at 59: cmd
//  1 bit  at 64: from portable (/P)
//  1 bit  at 65: to portable
//  6 bits at 66: e.g. SNR
//
std::string
unpack_directed(const int a87[87], std::string &other_call)
{
  int portable_from = un(a87, 64, 1);
  int portable_to = un(a87, 65, 1);
  std::string call1 = unpack_call(un(a87, 3, 28));  // from
  std::string call2 = unpack_call(un(a87, 31, 28)); // to
  int cmd = un(a87, 59, 5);
  int extra = un(a87, 66, 6);

  other_call = call1;
  
  std::string cmd_text;
  if(cmd >= 0 && cmd < sizeof(directed_cmds) / sizeof(directed_cmds[0])){
    cmd_text = directed_cmds[cmd];
  }

  std::string ret;
  ret = "[";
  ret += call1; // from
  ret += " ";
  ret += call2; // to
  ret += " ";
  if(cmd_text.size() > 0){
    ret += cmd_text;
  } else {
    ret += std::to_string(cmd);
  }
  ret += " ";
  if(cmd == 25){
    // SNR
    ret += std::to_string(extra - 31);
  } else {
    ret += std::to_string(extra);
  }
  ret += "]";
  return ret;
}

//
// turn a 50-bit number into a callsign.
// from JS8Call's unpackAlphaNumeric50().
// used for callsign in heartbeat and CQ msgs.
//
std::string
unpack_50(unsigned long long x)
{
  const char *v = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@";
  char s[12];

  int o = 11;
  s[o--] = '\0';

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = (x & 1) ? '/' : ' ';
  x /= 2;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = (x & 1) ? '/' : ' ';
  x /= 2;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 38];
  x /= 38;

  s[o--] = v[x % 39];

  // squeeze out spaces.
  std::string ss;
  for(int i = 0; s[i] != '\0'; i++){
    if(s[i] != ' '){
      ss.push_back(s[i]);
    }
  }

  return ss;
}

//
// heartbeat/CQ message.
//
//  3 bits at  0: 0 0 0
// 50 bits at  3: callsign
// 16 bits at 53: 16-bit "num"
//  3 bits at 69: "bits3"
//
// if high (15th) bit of num is clear, it's a heartbeat,
// and bits3 indexes hbs[].
//
// if high (15th) bit of num is set, it's a CQ.
// and bits3 indexes cqs[].
//

const char *hbs[] = {
  "HB",
  "HB AUTO",
  "HB AUTO RELAY",
  "HB AUTO RELAY SPOT",
  "HB RELAY",
  "HB RELAY SPOT",
  "HB SPOT",
  "HB AUTO SPOT",
};

const char *cqs[] = {
  "CQ CQ CQ",
  "CQ DX",
  "CQ QRP",
  "CQ CONTEST",
  "CQ FIELD",
  "CQ FD",
  "CQ CQ",
  "CQ",
};

// unpack a 15-bit grid square.
std::string
unpack_grid(int ng)
{
  // maidenhead grid system:
  //   latitude from south pole to north pole.
  //   longitude eastward from anti-meridian.
  //   first: 20 degrees longitude.
  //   second: 10 degrees latitude.
  //   third: 2 degrees longitude.
  //   fourth: 1 degree latitude.
  // the latitude is in the low % 180 of the 15-bit value,
  // in one-degree units.
  // the longitude is * 180, in 2-degree units.
  int lat = (ng % 180);
  int lng = ((ng / 180) * 2) - 180;
  char tmp[5];
  tmp[0] = 'A' + (179 - lng) / 20;
  tmp[1] = 'A' + lat / 10;
  tmp[2] = '0' + ((179 - lng) % 20) / 2;
  tmp[3] = '0' + lat % 10;
  tmp[4] = '\0';
  return tmp;
}

std::string
unpack_heartbeat(const int a87[87], std::string &other_call)
{
  other_call = unpack_50(un(a87, 3, 50));
  unsigned int num = un(a87, 53, 16);
  unsigned int bits3 = un(a87, 69, 3);

  std::string ret;
  ret += other_call;
  ret += ": ";

  if(num & 0x8000){
    // cq
    ret += cqs[bits3];
  } else {
    // heartbeat
    ret += hbs[bits3];
  }

  if((num & 0x7fff) != 0x7fff){
    ret += " ";
    ret += unpack_grid(num & 0x7fff);
  }

  return ret;
}

//
// Extract i3 bits (transmission type) from bits 72-74
// Returns: 0-7 value encoding transmission type
//   000 = Normal frame (continuation)
//   001 = First frame
//   010 = Last frame
//   100 = Data frame (no frame header)
//
int
extract_i3(const int a87[87])
{
  return (a87[72] << 2) | (a87[73] << 1) | a87[74];
}

//
// a87[] holds the entire 87 decoded bits.
// really 72, omitting 12-bit CRC and 3 unused bits.
//
std::string
unpack(const int a87[87], std::string &other_call)
{
  other_call.erase();
  
  load_words();

  std::string msg;

  if(a87[0] == 0 && a87[1] == 1 && a87[2] == 1){
    msg = unpack_directed(a87, other_call);
  } else if(a87[0] == 0 && a87[1] == 0 && a87[2] == 0){
    msg = unpack_heartbeat(a87, other_call);
  } else if(a87[0] == 1 && a87[1] == 0){
    msg = unpack_huffman(a87);
  } else if(a87[0] == 1 && a87[1] == 1){
    msg = unpack_dense(a87);
  } else if(a87[0] == 0 && a87[1] == 0 && a87[2] == 1){
    // Compound
    return "Compound";
  } else if(a87[0] == 0 && a87[1] == 1 && a87[2] == 0){
    // Compound Directed
    return "CompoundDirected";
  } else {
    char buf[512];
    sprintf(buf, "can't parse, starts with %d %d %d\n",
            a87[0], a87[1], a87[2]);
    return std::string(buf);
  }

#if 0
  char anno[64];
  sprintf(anno, " <%d%d%d, %d%d%d>",
          a87[0], a87[1], a87[2],
          a87[72], a87[73], a87[74]);
  msg += std::string(anno);
#endif

  return msg;
}
