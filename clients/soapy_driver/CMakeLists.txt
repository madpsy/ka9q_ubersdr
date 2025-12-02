cmake_minimum_required(VERSION 3.1)
project(SoapyUberSDR CXX)

# Find SoapySDR
find_package(SoapySDR "0.8" NO_MODULE)
if (NOT SoapySDR_FOUND)
    find_package(SoapySDR "0.7" REQUIRED)
endif()

# Find websocketpp (header-only library)
find_path(WEBSOCKETPP_INCLUDE_DIR NAMES websocketpp/client.hpp)
if(NOT WEBSOCKETPP_INCLUDE_DIR)
    message(FATAL_ERROR "websocketpp not found. Install with: sudo apt-get install libwebsocketpp-dev")
endif()
message(STATUS "WebSocket++ include dir: ${WEBSOCKETPP_INCLUDE_DIR}")

# Find Boost (required by websocketpp)
find_package(Boost REQUIRED COMPONENTS system)

# Find OpenSSL (for WSS support)
find_package(OpenSSL REQUIRED)

# Find CURL (for HTTP connection check)
find_package(CURL REQUIRED)

# Build the driver module
add_library(uberSDRSupport MODULE
    SoapyUberSDR.cpp
)

target_include_directories(uberSDRSupport PRIVATE
    ${WEBSOCKETPP_INCLUDE_DIR}
    ${Boost_INCLUDE_DIRS}
    ${OPENSSL_INCLUDE_DIR}
)

target_link_libraries(uberSDRSupport
    SoapySDR
    ${Boost_LIBRARIES}
    ${OPENSSL_LIBRARIES}
    ${CURL_LIBRARIES}
    pthread
)

set_target_properties(uberSDRSupport PROPERTIES
    CXX_STANDARD 11
    CXX_STANDARD_REQUIRED ON
)

# Install to SoapySDR modules directory
install(TARGETS uberSDRSupport
    DESTINATION lib/SoapySDR/modules${SOAPY_SDR_ABI_VERSION}
)

# Print build information
message(STATUS "SoapySDR include dir: ${SoapySDR_INCLUDE_DIRS}")
message(STATUS "SoapySDR libraries: ${SoapySDR_LIBRARIES}")
message(STATUS "WebSocket++ include dir: ${WEBSOCKETPP_INCLUDE_DIR}")