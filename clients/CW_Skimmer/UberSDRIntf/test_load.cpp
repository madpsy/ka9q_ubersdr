// test_load.cpp - Simple test to check if DLL loads
#include <windows.h>
#include <stdio.h>

int main()
{
    printf("Attempting to load UberSDRIntf.dll...\n");
    
    HMODULE hDll = LoadLibraryA("UberSDRIntf.dll");
    if (hDll == NULL)
    {
        DWORD error = GetLastError();
        printf("Failed to load DLL! Error code: %d\n", error);
        
        // Common error codes:
        // 126 = The specified module could not be found (missing dependency)
        // 193 = Not a valid Win32 application (wrong architecture)
        // 127 = The specified procedure could not be found
        
        if (error == 126) {
            printf("Error 126: Missing dependency DLL\n");
            printf("Run 'dumpbin /DEPENDENTS UberSDRIntf.dll' to see dependencies\n");
        } else if (error == 193) {
            printf("Error 193: Wrong architecture (need 32-bit)\n");
        }
        
        return 1;
    }
    
    printf("DLL loaded successfully!\n");
    
    // Try to get function addresses
    typedef void (__stdcall *tGetSdrInfo)(void* pInfo);
    tGetSdrInfo pGetSdrInfo = (tGetSdrInfo)GetProcAddress(hDll, "GetSdrInfo");
    
    if (pGetSdrInfo == NULL) {
        printf("Failed to find GetSdrInfo function!\n");
    } else {
        printf("GetSdrInfo function found at: %p\n", pGetSdrInfo);
    }
    
    FreeLibrary(hDll);
    printf("DLL unloaded successfully\n");
    
    return 0;
}