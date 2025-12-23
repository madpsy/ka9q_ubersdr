cmake_minimum_required(VERSION 3.15)
project(UberSDRIntf VERSION 1.0.0 LANGUAGES CXX)

# Force 32-bit build (CW Skimmer is 32-bit)
set(CMAKE_GENERATOR_PLATFORM Win32)

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Use static runtime library (like HermesIntf) to avoid dependency issues
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Define the DLL
add_library(UberSDRIntf SHARED
    UberSDRIntf.cpp
    UberSDR.cpp
    UberSDRIntf.def
)

# Define export macro
target_compile_definitions(UberSDRIntf PRIVATE UBERSDRINTF_EXPORTS)

# Disable TLS for IXWebSocket
target_compile_definitions(UberSDRIntf PRIVATE 
    IXWEBSOCKET_USE_TLS=0
    IXWEBSOCKET_USE_OPEN_SSL=0
)

# Find zstd library
find_package(zstd CONFIG REQUIRED)

# Include directories
target_include_directories(UberSDRIntf PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/IXWebSocket
)

# Add IXWebSocket source files manually (excluding SSL/TLS files)
target_sources(UberSDRIntf PRIVATE
    IXWebSocket/ixwebsocket/IXBench.cpp
    IXWebSocket/ixwebsocket/IXCancellationRequest.cpp
    IXWebSocket/ixwebsocket/IXConnectionState.cpp
    IXWebSocket/ixwebsocket/IXDNSLookup.cpp
    IXWebSocket/ixwebsocket/IXExponentialBackoff.cpp
    IXWebSocket/ixwebsocket/IXGetFreePort.cpp
    IXWebSocket/ixwebsocket/IXGzipCodec.cpp
    IXWebSocket/ixwebsocket/IXHttp.cpp
    IXWebSocket/ixwebsocket/IXHttpClient.cpp
    IXWebSocket/ixwebsocket/IXHttpServer.cpp
    IXWebSocket/ixwebsocket/IXNetSystem.cpp
    IXWebSocket/ixwebsocket/IXSelectInterrupt.cpp
    IXWebSocket/ixwebsocket/IXSelectInterruptEvent.cpp
    IXWebSocket/ixwebsocket/IXSelectInterruptFactory.cpp
    IXWebSocket/ixwebsocket/IXSelectInterruptPipe.cpp
    IXWebSocket/ixwebsocket/IXSetThreadName.cpp
    IXWebSocket/ixwebsocket/IXSocket.cpp
    IXWebSocket/ixwebsocket/IXSocketConnect.cpp
    IXWebSocket/ixwebsocket/IXSocketServer.cpp
    IXWebSocket/ixwebsocket/IXSocketTLSOptions.cpp
    IXWebSocket/ixwebsocket/IXStrCaseCompare.cpp
    IXWebSocket/ixwebsocket/IXUdpSocket.cpp
    IXWebSocket/ixwebsocket/IXUrlParser.cpp
    IXWebSocket/ixwebsocket/IXUuid.cpp
    IXWebSocket/ixwebsocket/IXWebSocket.cpp
    IXWebSocket/ixwebsocket/IXWebSocketCloseConstants.cpp
    IXWebSocket/ixwebsocket/IXWebSocketHandshake.cpp
    IXWebSocket/ixwebsocket/IXWebSocketHttpHeaders.cpp
    IXWebSocket/ixwebsocket/IXWebSocketPerMessageDeflate.cpp
    IXWebSocket/ixwebsocket/IXWebSocketPerMessageDeflateCodec.cpp
    IXWebSocket/ixwebsocket/IXWebSocketPerMessageDeflateOptions.cpp
    IXWebSocket/ixwebsocket/IXWebSocketProxyServer.cpp
    IXWebSocket/ixwebsocket/IXWebSocketServer.cpp
    IXWebSocket/ixwebsocket/IXWebSocketTransport.cpp
    # Stub versions (no OpenSSL)
    IXSocketFactoryStub.cpp
    IXUserAgentStub.cpp
)

# Link libraries
target_link_libraries(UberSDRIntf PRIVATE
    ws2_32
    crypt32
    zstd::libzstd_static
)

# Set output name
set_target_properties(UberSDRIntf PROPERTIES
    OUTPUT_NAME "UberSDRIntf"
    PREFIX ""
)

# Installation
install(TARGETS UberSDRIntf
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)

# Copy to build directory for testing
add_custom_command(TARGET UberSDRIntf POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:UberSDRIntf> ${CMAKE_BINARY_DIR}/
    COMMENT "Copying DLL to build directory"
)