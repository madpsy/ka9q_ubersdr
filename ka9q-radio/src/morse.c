// Morse code generation
// Copyright 2022-2023, Phil Karn, KA9Q
#include <stdio.h>
#include <wchar.h>
#include <wctype.h>
#include <unistd.h>
#include <stdlib.h>
#include <ctype.h>
#include <stdint.h>
#include <locale.h>
#include <fcntl.h>
#include <string.h>
#include <arpa/inet.h>
#include "misc.h"
#include "osc.h"
#include "morse.h"

struct morse {
  wint_t c;
  char const *code;
};

// Gets sorted at startup for binary search
// Table from Wikipedia: http://en.wikipedia.org/wiki/Morse_code
static struct morse Morse_table[] = {
  { ' ', " " },
  { 'a', "._" },
  { 'b', "_..." },
  { 'c', "_._." },
  { 'd', "_.." },
  { 'e', "." },
  { 'f', ".._." },
  { 'g', "__." },
  { 'h', "...." },
  { 'i', ".." },
  { 'j', ".___" },
  { 'k', "_._" },
  { 'l', "._.." },
  { 'm', "__" },
  { 'n', "_." },
  { 'o', "___" },
  { 'p', ".__." },
  { 'q', "__._", },
  { 'r', "._." },
  { 's', "..." },
  { 't', "_" },
  { 'u', ".._" },
  { 'v', "..._" },
  { 'w', ".__" },
  { 'x', "_.._" },
  { 'y', "_.__" },
  { 'z', "__.." },
  { '0', "_____" },
  { '1', ".____" },
  { '2', "..___" },
  { '3', "...__" },
  { '4', "...._" },
  { '5', "....." },
  { '6', "_...." },
  { '7', "__..." },
  { '8', "___.." },
  { '9', "____." },
  { '.', "._._._" },
  { ',', "__..__" },
  { '?', "..__.." },
  { '\'', ".____." },
  { '!', "_._.__" },
  { '/', "_.._." },
  { '(', "_.__." },
  { ')', "_.__._" },
  { '&', "._..." },
  { ':', "___..." },
  { ';', "_._._." },
  { '=', "_..._" },
  { '+', "._._." },
  { '-', "_...._" },
  { '_', "..__._" },
  { '"', "._.._." },
  { '$', "..._.._" },
  { '@', ".__._." },

  // Accented Latin
  { L'à', ".__._" },  // a + accent grave
  { L'ä', "._._" },   // a + umlaut
  { L'ą', "._._"},    //a + ogonek
  { L'æ', "._._" },   // ae
  { L'å', ".__._" }, 
  { L'ć', "_._.." },  // c/C + accent acute
  { L'ĉ', "_._.." },  // c/C + circumflex
  { L'ç', "_.-.." },  
  // ch as a digraph has no unicode encoding
  { L'đ', ".._.." },  // d/D with stroke
  { L'ð', "..__." },  // eth (very similar to D with stroke)
  { L'é', ".._.." },  // e/E with accent acute
  { L'ę', ".._.." },  // e/E with tail
  { L'ĝ', "__._." },  // g/G with circumflex */
  { L'ĥ', "____" },   // h/H with circumflex */
  { L'ĵ', ".___." },  // j/J with circumflex */
  { L'ł', "._.._" },  // l/L with stroke */
  { L'ń', "__.__" },  // n/N with accent acute */
  { L'ñ', "__.__" },  // n/N with tilde (Spanish ene) 
  { L'ó', "___." },   // o/O with accent acute
  { L'ö', "___." },   // o/O with umlaut
  { L'ø', "___." },   // o/O with stroke
  { L'ś', "..._..." },// s/S with accent acute
  { L'ŝ', "..._." },  // s/S with circumflex (esperanto)
  { L'š', "____" },   // s/S with caron
  { L'þ', ".__.." },  // Thorn
  { L'ü', "..__" },   // u/U with umlaut
  { L'ŭ', "..__" },   // u/U with breve
  { L'ź', "__.._." }, // z/Z with accent acute
  { L'ż', "__.._" },  // z/Z with overdot
  { L'ß', "...__.." }, // German sharp s

  // Greek
  { L'α', "._" }, // alpha
  { L'β', "_..."},// beta
  { L'γ', "__."}, // gamma
  { L'δ', "_.."}, // delta
  { L'ε', "."},   // epsilon
  { L'ζ', "__.."},// zeta
  { L'η', "...."},// eta
  { L'θ', "_._."},// theta
  { L'ι', ".."},  // iota
  { L'κ',"_._"},  // kappa
  { L'λ',"._.."}, // lambda
  { L'μ',"__"},   // mu
  { L'ν',"_."},   // nu
  { L'ξ',"_.._"}, // xi
  { L'ο',"___"},  // omicron
  { L'π',".__."}, // pi
  { L'ρ',"._."},  // rho
  { L'σ',"..."},  // sigma
  { L'ς',"..."},  // final sigma (stigma)
  { L'τ',"_"},    // tau
  { L'υ',"_.__"}, // upsilon
  { L'φ',".._."}, // phi
  { L'χ',"____"}, // chi
  { L'ψ',"__._"}, // psi
  { L'ω',".__"},  // omega

  // Russian
  { L'а',"._"},
  { L'б',"_..."},
  { L'в',".__"},
  { L'г',"__."},
  { L'д',"_.."},
  { L'е',"."},
  { L'ж',"..._"},
  { L'з',"__.."},
#ifdef UKRAINIAN
  { L'и',"_.__"}, // conflicts with same character in Russian
#else // Russian
  { L'и',".."},
#endif
  { L'й',".___"},
  { L'к',"_._"},
  { L'л',"._.."},
  { L'м',"__"},
  { L'н',"_."},
  { L'о',"___"},
  { L'п',".__."},
  { L'р',"._."},
  { L'с',"..."},
  { L'т',"_"},
  { L'у',".._"},
  { L'ф',".._."},
  { L'х',"...."},
  { L'ц',"_._."},
  { L'ч',"___."},
  { L'ш',"____"},
  { L'щ',"__._"},
  { L'ь',"_.._"},
  { L'ы',"_.__"},
  { L'э',".._.."},
  { L'ю',"..__"},
  { L'я',"._._"},
  { L'ё',"."}, // Same as 'е'
  // Ukrainian variants that don't conflict with Russian
  { L'є',".._.."},
  { L'і',".."},
  { L'ї',".___."},

  // Hebrew (did I get this right?)
  { L'א',"._"},   // alef 
  { L'ב',"_..."}, // bet  
  { L'ג',"__."},  // gimel
  { L'ד',"_.."},  // dalet
  { L'ה',"___"},  // he
  { L'ו',"."},    // vav
  { L'ז',"__.."}, // zayin
  { L'ח',"...."}, // het
  { L'ט',".._"},  // tet
  { L'י',".."},   // yod
  { L'ך',"_._"},  // final kaf
  { L'כ',"_._"},  // kaf
  { L'ל',"._.."}, // lamed
  { L'ם',"__"},   // final mem
  { L'מ',"__"},   // mem
  { L'ן',"_."},   // final nun
  { L'נ',"_."},   // nun
  { L'ס',"_._."}, // samekh
  { L'ע',".___"}, // ayin
  { L'ף',".__."}, // final pe
  { L'פ',".__."}, // pe
  { L'ץ',".__"},  // final tsadi
  { L'צ',".__"},  // tsadi
  { L'ק',"__._"}, // qof
  { L'ר',"._."},  // resh
  { L'ש',"..."},  // shin
  { L'ת',"_"},    // tav
};
    
#define TABSIZE (sizeof(Morse_table)/sizeof(Morse_table[0]))

// Comparison function for sort and bsearch on Morse table
static int mcompar(const void *a,const void *b){
  const struct morse * const am = (struct morse *)a;
  const struct morse * const bm = (struct morse *)b;
  
  if(am->c < bm->c)
    return -1;
  else if(am->c > bm->c)
    return +1;
  else
    return 0;
}


// Precomputed dots and dashes, stored in network byte order
static int Dit_length; // # samples in the key-down period of a dit
static float *Dit;  // one element key-down, one element key-up
static float *Dah;  // three elements key-down, one element key-up


// Encode a single Morse character as audio samples
// Return number of samples generated
// Buffer must be long enough! 60 dit times is recommended
int encode_morse_char(float * const samples,wint_t c){
  if(samples == NULL || Dit_length == 0)
    return 0; // Bad arg, or not initialized

  c = towlower(c);

  struct morse const * const mp = bsearch(&c,Morse_table,TABSIZE,sizeof(Morse_table[0]),mcompar);
  if(mp == NULL)
    return 0;

  float *outp = samples;
  for(int j=0;mp->code[j] != 0; j++){
    switch(mp->code[j]){
    case ' ':
      // inter-word space, 4 dits
      for(int k=0; k < 4 * Dit_length; k++)
	*outp++ = 0;
      break;
    case '.':
      // One dit on, one dit off
      for(int k=0; k < 2 * Dit_length; k++)
	*outp++ = Dit[k];
      break;
    case '-':
    case '_':
      // three dits on, one dit off
      for(int k=0; k < 4 * Dit_length; k++)
	*outp++ = Dah[k];
      break;
    default:
      break; // Ignore
    }
  }
  // Inter-letter space (2 additional dits = 3 total)
  for(int k=0; k < 2 * Dit_length; k++)
    *outp++ = 0;

  return outp - samples;
}

// Initialize morse encoder, return number of samples in a dit
int init_morse(float const speed,float const pitch,float level,float const samprate){
  qsort(Morse_table,TABSIZE,sizeof(Morse_table[0]),mcompar);

  Dit_length = samprate * 1.2 / speed; // Samples per dit
  double const cycles_per_sample = pitch / samprate;

  if(Verbose){
    fprintf(stderr,"speed %.1f wpm, pitch %.1f Hz, level %.1f dB, samprate %.1f Hz\n",
	    speed,pitch,level,samprate);
    fprintf(stderr,"dit length %d samples; cycles per sample %lf\n",Dit_length,cycles_per_sample);
  }
  level = dB2voltage(-fabsf(level)); // convert dB to amplitude

  // Precompute element audio
  struct osc tone;
  memset(&tone,0,sizeof(tone));
  set_osc(&tone,cycles_per_sample,0.0);

  // Exponential envelope shaping to avoid key clicks
  double const tau = .005; // 5 ms time constant sounds good
  double const g = -expm1(-1/(samprate * tau)); // -expm1(x) = 1 - exp(x)

  FREE(Dit);
  Dit = calloc(2*Dit_length,sizeof(Dit[0]));

  FREE(Dah);
  Dah = calloc(4*Dit_length,sizeof(Dah[0]));

  // First element of dit and dah are the same
  int k;
  double envelope = 0;
  for(k=0; k < Dit_length; k++){
    float s = level * (float)creal(step_osc(&tone));
    Dah[k] = Dit[k] = s * envelope;
    envelope += g * (1 - envelope);
  }

  // Second element of dah continues while dit decays
  double dit_envelope = envelope;
  double dah_envelope = envelope;

  for(; k < 2*Dit_length; k++){
    float s = level * (float)creal(step_osc(&tone));
    Dit[k] = s * dit_envelope;
    Dah[k] = s * dah_envelope;    
    dit_envelope += g * (0 - dit_envelope);
    dah_envelope += g * (1 - dah_envelope);    
  }
  // Third element of dah continues
  for(; k < 3*Dit_length; k++){
    float s = level * (float)creal(step_osc(&tone));
    Dah[k] = s * dah_envelope;    
    dah_envelope += g * (1 - dah_envelope);    
  }
  // Fourth element of dah decays
  for(; k < 4*Dit_length; k++){
    float s = level * (float)creal(step_osc(&tone));
    Dah[k] = s * dah_envelope;
    dah_envelope += g * (0 - dah_envelope);    
  }
  // end initialization
  return Dit_length;
}
