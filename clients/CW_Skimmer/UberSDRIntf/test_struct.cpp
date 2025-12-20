// test_struct.cpp - Test structure layout
#include <windows.h>
#include <stdio.h>

// Copy exact structure definitions from UberSDRIntf.h
#define RATE_48KHZ    0
#define RATE_96KHZ    1
#define RATE_192KHZ   2
#define BLOCKS_PER_SEC  93.75
#define MAX_RX_COUNT  8

#pragma pack(push, 16) 
typedef struct {float Re, Im;} Cmplx;
typedef Cmplx *CmplxA;
typedef CmplxA *CmplxAA;
#pragma pack(pop) 

typedef void (__stdcall *tIQProc)(int RxHandle, CmplxAA Data);
typedef void (__stdcall *tAudioProc)(int RxHandle, CmplxA InIq, CmplxA OutLR, int OutCount);
typedef void (__stdcall *tLoadProgressProc)(int RxHandle, int Current, int Total);
typedef void (__stdcall *tErrorProc)(int RxHandle, char *ErrText);
typedef void (__stdcall *tStatusBitsProc)(int RxHandle, unsigned char Bits);

typedef struct {
    char *DeviceName;
    int   MaxRecvCount;
    float ExactRates[3];
} SdrInfo, *PSdrInfo;

typedef struct {
    int  THandle;
    int  RecvCount;
    int  RateID;
    BOOL LowLatency;
    tIQProc           pIQProc;
    tAudioProc        pAudioProc;
    tStatusBitsProc   pStatusBitProc;
    tLoadProgressProc pLoadProgressProc;
    tErrorProc        pErrorProc;
} SdrSettings, *PSdrSettings;

int main()
{
    printf("Structure sizes:\n");
    printf("sizeof(Cmplx) = %d\n", sizeof(Cmplx));
    printf("sizeof(SdrInfo) = %d\n", sizeof(SdrInfo));
    printf("sizeof(SdrSettings) = %d\n", sizeof(SdrSettings));
    printf("\n");
    
    printf("SdrSettings field offsets:\n");
    printf("THandle offset: %d\n", offsetof(SdrSettings, THandle));
    printf("RecvCount offset: %d\n", offsetof(SdrSettings, RecvCount));
    printf("RateID offset: %d\n", offsetof(SdrSettings, RateID));
    printf("LowLatency offset: %d\n", offsetof(SdrSettings, LowLatency));
    printf("pIQProc offset: %d\n", offsetof(SdrSettings, pIQProc));
    printf("pAudioProc offset: %d\n", offsetof(SdrSettings, pAudioProc));
    printf("pStatusBitProc offset: %d\n", offsetof(SdrSettings, pStatusBitProc));
    printf("pLoadProgressProc offset: %d\n", offsetof(SdrSettings, pLoadProgressProc));
    printf("pErrorProc offset: %d\n", offsetof(SdrSettings, pErrorProc));
    
    return 0;
}