cmake_minimum_required(VERSION 3.10)
project(UberSDRMonitor)

# Set C++ standard
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add executable
add_executable(UberSDRMonitor WIN32
    UberSDRMonitor.cpp
    UberSDRMonitor.rc
    resource.h
    ../UberSDRIntf/UberSDRShared.h
)

# Link libraries
target_link_libraries(UberSDRMonitor
    comctl32
    ws2_32
)

# Set output directory
set_target_properties(UberSDRMonitor PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

# For MSVC, disable UNICODE to use ANSI strings
if(MSVC)
    target_compile_definitions(UberSDRMonitor PRIVATE
        _MBCS
        WIN32
        _WINDOWS
    )
endif()