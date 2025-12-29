// UberSDRShared.cpp - Shared functions for multi-instance support
// These functions are used by both the DLL and the monitor application

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include "UberSDRShared.h"

///////////////////////////////////////////////////////////////////////////////
// Get current time in milliseconds
int64_t GetCurrentTimeMs()
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER uli;
    uli.LowPart = ft.dwLowDateTime;
    uli.HighPart = ft.dwHighDateTime;
    // Convert from 100-nanosecond intervals to milliseconds
    return (int64_t)(uli.QuadPart / 10000ULL - 11644473600000ULL);
}

///////////////////////////////////////////////////////////////////////////////
// Build shared memory name for a given process ID
void BuildSharedMemoryName(DWORD processID, wchar_t* buffer, size_t bufferSize)
{
    swprintf_s(buffer, bufferSize, L"%s_%u", UBERSDR_SHARED_MEMORY_PREFIX, processID);
}

///////////////////////////////////////////////////////////////////////////////
// Register instance in registry
BOOL RegisterInstance(DWORD processID, const char* serverHost, int serverPort, int64_t startTime)
{
    HKEY hKey = NULL;
    HKEY hInstanceKey = NULL;
    LONG result;
    
    // Create or open the Instances key
    result = RegCreateKeyExW(HKEY_CURRENT_USER, UBERSDR_REGISTRY_INSTANCES,
                             0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL);
    if (result != ERROR_SUCCESS) {
        return FALSE;
    }
    
    // Create subkey for this process ID
    wchar_t subkeyName[32];
    swprintf_s(subkeyName, 32, L"%u", processID);
    result = RegCreateKeyExW(hKey, subkeyName, 0, NULL, 0, KEY_WRITE, NULL, &hInstanceKey, NULL);
    RegCloseKey(hKey);
    
    if (result != ERROR_SUCCESS) {
        return FALSE;
    }
    
    // Write process ID
    RegSetValueExW(hInstanceKey, L"ProcessID", 0, REG_DWORD, (BYTE*)&processID, sizeof(DWORD));
    
    // Write server host (convert to wide string)
    wchar_t wServerHost[64];
    MultiByteToWideChar(CP_UTF8, 0, serverHost, -1, wServerHost, 64);
    RegSetValueExW(hInstanceKey, L"ServerHost", 0, REG_SZ, (BYTE*)wServerHost,
                  (DWORD)((wcslen(wServerHost) + 1) * sizeof(wchar_t)));
    
    // Write server port
    RegSetValueExW(hInstanceKey, L"ServerPort", 0, REG_DWORD, (BYTE*)&serverPort, sizeof(DWORD));
    
    // Write start time
    RegSetValueExW(hInstanceKey, L"StartTime", 0, REG_QWORD, (BYTE*)&startTime, sizeof(int64_t));
    
    // Write shared memory name
    wchar_t memName[128];
    BuildSharedMemoryName(processID, memName, 128);
    RegSetValueExW(hInstanceKey, L"SharedMemoryName", 0, REG_SZ, (BYTE*)memName,
                  (DWORD)((wcslen(memName) + 1) * sizeof(wchar_t)));
    
    // Write initial heartbeat
    int64_t now = GetCurrentTimeMs();
    RegSetValueExW(hInstanceKey, L"LastHeartbeat", 0, REG_QWORD, (BYTE*)&now, sizeof(int64_t));
    
    RegCloseKey(hInstanceKey);
    return TRUE;
}

///////////////////////////////////////////////////////////////////////////////
// Unregister instance from registry
BOOL UnregisterInstance(DWORD processID)
{
    HKEY hKey = NULL;
    LONG result;
    
    // Open the Instances key
    result = RegOpenKeyExW(HKEY_CURRENT_USER, UBERSDR_REGISTRY_INSTANCES,
                          0, KEY_WRITE, &hKey);
    if (result != ERROR_SUCCESS) {
        return FALSE;  // Key doesn't exist, nothing to clean up
    }
    
    // Delete subkey for this process ID
    wchar_t subkeyName[32];
    swprintf_s(subkeyName, 32, L"%u", processID);
    result = RegDeleteKeyW(hKey, subkeyName);
    RegCloseKey(hKey);
    
    return (result == ERROR_SUCCESS);
}

///////////////////////////////////////////////////////////////////////////////
// Update instance heartbeat in registry
BOOL UpdateInstanceHeartbeat(DWORD processID)
{
    HKEY hKey = NULL;
    HKEY hInstanceKey = NULL;
    LONG result;
    
    // Open the Instances key
    result = RegOpenKeyExW(HKEY_CURRENT_USER, UBERSDR_REGISTRY_INSTANCES,
                          0, KEY_READ, &hKey);
    if (result != ERROR_SUCCESS) {
        return FALSE;
    }
    
    // Open subkey for this process ID
    wchar_t subkeyName[32];
    swprintf_s(subkeyName, 32, L"%u", processID);
    result = RegOpenKeyExW(hKey, subkeyName, 0, KEY_WRITE, &hInstanceKey);
    RegCloseKey(hKey);
    
    if (result != ERROR_SUCCESS) {
        return FALSE;
    }
    
    // Update heartbeat
    int64_t now = GetCurrentTimeMs();
    result = RegSetValueExW(hInstanceKey, L"LastHeartbeat", 0, REG_QWORD,
                           (BYTE*)&now, sizeof(int64_t));
    RegCloseKey(hInstanceKey);
    
    return (result == ERROR_SUCCESS);
}

///////////////////////////////////////////////////////////////////////////////
// Enumerate all instances from registry
int EnumerateInstances(UberSDRInstanceInfo* instances, int maxInstances)
{
    HKEY hKey = NULL;
    LONG result;
    int count = 0;
    
    // Open the Instances key
    result = RegOpenKeyExW(HKEY_CURRENT_USER, UBERSDR_REGISTRY_INSTANCES,
                          0, KEY_READ, &hKey);
    if (result != ERROR_SUCCESS) {
        return 0;  // No instances registered
    }
    
    // Enumerate subkeys
    DWORD index = 0;
    wchar_t subkeyName[256];
    DWORD subkeyNameSize;
    
    while (count < maxInstances)
    {
        subkeyNameSize = 256;
        result = RegEnumKeyExW(hKey, index, subkeyName, &subkeyNameSize,
                              NULL, NULL, NULL, NULL);
        if (result != ERROR_SUCCESS) {
            break;  // No more subkeys
        }
        
        index++;
        
        // Open this instance's subkey
        HKEY hInstanceKey = NULL;
        result = RegOpenKeyExW(hKey, subkeyName, 0, KEY_READ, &hInstanceKey);
        if (result != ERROR_SUCCESS) {
            continue;
        }
        
        // Read instance information
        UberSDRInstanceInfo info;
        ZeroMemory(&info, sizeof(info));
        info.isValid = false;
        
        DWORD dataSize;
        DWORD dataType;
        
        // Read ProcessID
        dataSize = sizeof(DWORD);
        if (RegQueryValueExW(hInstanceKey, L"ProcessID", NULL, &dataType,
                           (BYTE*)&info.processID, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        // Read ServerHost
        dataSize = sizeof(info.serverHost);
        if (RegQueryValueExW(hInstanceKey, L"ServerHost", NULL, &dataType,
                           (BYTE*)info.serverHost, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        // Read ServerPort
        dataSize = sizeof(DWORD);
        if (RegQueryValueExW(hInstanceKey, L"ServerPort", NULL, &dataType,
                           (BYTE*)&info.serverPort, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        // Read StartTime
        dataSize = sizeof(int64_t);
        if (RegQueryValueExW(hInstanceKey, L"StartTime", NULL, &dataType,
                           (BYTE*)&info.startTime, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        // Read LastHeartbeat
        dataSize = sizeof(int64_t);
        if (RegQueryValueExW(hInstanceKey, L"LastHeartbeat", NULL, &dataType,
                           (BYTE*)&info.lastHeartbeat, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        // Read SharedMemoryName
        dataSize = sizeof(info.sharedMemoryName);
        if (RegQueryValueExW(hInstanceKey, L"SharedMemoryName", NULL, &dataType,
                           (BYTE*)info.sharedMemoryName, &dataSize) != ERROR_SUCCESS) {
            RegCloseKey(hInstanceKey);
            continue;
        }
        
        RegCloseKey(hInstanceKey);
        
        // Verify process still exists
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, info.processID);
        if (hProcess != NULL) {
            CloseHandle(hProcess);
            
            // Check heartbeat freshness
            int64_t now = GetCurrentTimeMs();
            if ((now - info.lastHeartbeat) < UBERSDR_HEARTBEAT_TIMEOUT) {
                info.isValid = true;
                instances[count++] = info;
            }
        }
    }
    
    RegCloseKey(hKey);
    return count;
}

///////////////////////////////////////////////////////////////////////////////
// Cleanup stale instances from registry
void CleanupStaleInstances()
{
    HKEY hKey = NULL;
    LONG result;
    
    // Open the Instances key
    result = RegOpenKeyExW(HKEY_CURRENT_USER, UBERSDR_REGISTRY_INSTANCES,
                          0, KEY_READ | KEY_WRITE, &hKey);
    if (result != ERROR_SUCCESS) {
        return;  // No instances to clean up
    }
    
    // Enumerate subkeys and collect stale ones
    wchar_t staleKeys[16][256];  // Support up to 16 stale keys
    int staleCount = 0;
    DWORD index = 0;
    wchar_t subkeyName[256];
    DWORD subkeyNameSize;
    
    while (staleCount < 16)
    {
        subkeyNameSize = 256;
        result = RegEnumKeyExW(hKey, index, subkeyName, &subkeyNameSize,
                              NULL, NULL, NULL, NULL);
        if (result != ERROR_SUCCESS) {
            break;
        }
        
        index++;
        
        // Open this instance's subkey
        HKEY hInstanceKey = NULL;
        result = RegOpenKeyExW(hKey, subkeyName, 0, KEY_READ, &hInstanceKey);
        if (result != ERROR_SUCCESS) {
            continue;
        }
        
        // Read ProcessID
        DWORD processID = 0;
        DWORD dataSize = sizeof(DWORD);
        DWORD dataType;
        if (RegQueryValueExW(hInstanceKey, L"ProcessID", NULL, &dataType,
                           (BYTE*)&processID, &dataSize) == ERROR_SUCCESS) {
            
            // Check if process exists
            HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processID);
            if (hProcess == NULL) {
                // Process doesn't exist - mark for cleanup
                wcscpy_s(staleKeys[staleCount], 256, subkeyName);
                staleCount++;
            } else {
                CloseHandle(hProcess);
                
                // Check heartbeat
                int64_t lastHeartbeat = 0;
                dataSize = sizeof(int64_t);
                if (RegQueryValueExW(hInstanceKey, L"LastHeartbeat", NULL, &dataType,
                                   (BYTE*)&lastHeartbeat, &dataSize) == ERROR_SUCCESS) {
                    int64_t now = GetCurrentTimeMs();
                    if ((now - lastHeartbeat) >= UBERSDR_HEARTBEAT_TIMEOUT) {
                        // Heartbeat too old - mark for cleanup
                        wcscpy_s(staleKeys[staleCount], 256, subkeyName);
                        staleCount++;
                    }
                }
            }
        }
        
        RegCloseKey(hInstanceKey);
    }
    
    // Delete stale keys
    for (int i = 0; i < staleCount; i++) {
        RegDeleteKeyW(hKey, staleKeys[i]);
    }
    
    RegCloseKey(hKey);
}
