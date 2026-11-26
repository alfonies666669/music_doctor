cmake_minimum_required(VERSION 3.24)
set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "macOS deployment target")
project(music_tags_file VERSION 0.9.1 LANGUAGES CXX OBJCXX)
if(NOT APPLE)
  message(FATAL_ERROR "Music Doctor requires macOS")
endif()

include(FetchContent)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_BINDINGS OFF CACHE BOOL "" FORCE)
set(BUILD_FRAMEWORK OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(WITH_ZLIB ON CACHE BOOL "" FORCE)
set(CMAKE_DISABLE_FIND_PACKAGE_utf8cpp ON)
# The official archive includes utf8cpp 4.2.0. The archive hash pins both.
FetchContent_Declare(taglib
  URL https://taglib.org/releases/taglib-2.3.2.tar.gz
  URL_HASH SHA256=3ca2d8afaa7f1cf7f6ed10e511ebc368bfacd6dcaa3dbfa690b89e502e8963dc
  TLS_VERIFY TRUE
)
if(FETCHCONTENT_SOURCE_DIR_TAGLIB)
  set(taglib_archive_source "${FETCHCONTENT_SOURCE_DIR_TAGLIB}")
else()
  set(taglib_archive_source "${FETCHCONTENT_BASE_DIR}/taglib-src")
endif()
set(utf8cpp_INCLUDE_DIR "${taglib_archive_source}/3rdparty/utfcpp/source" CACHE PATH "" FORCE)
FetchContent_MakeAvailable(taglib)
if(NOT TARGET ZLIB::ZLIB)
  find_package(ZLIB REQUIRED)
endif()

add_executable(music-tags-file file_tags.mm)
set_target_properties(music-tags-file PROPERTIES
  OBJCXX_STANDARD 17 OBJCXX_STANDARD_REQUIRED YES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
target_compile_options(music-tags-file PRIVATE -fobjc-arc -Wall -Wextra -Wno-deprecated-declarations)
target_include_directories(music-tags-file PRIVATE
  "${taglib_BINARY_DIR}"
  "${taglib_SOURCE_DIR}/taglib"
  "${taglib_SOURCE_DIR}/taglib/toolkit"
  "${taglib_SOURCE_DIR}/taglib/mpeg"
  "${taglib_SOURCE_DIR}/taglib/mpeg/id3v2"
  "${taglib_SOURCE_DIR}/taglib/mpeg/id3v2/frames"
  "${taglib_SOURCE_DIR}/taglib/mpeg/id3v1"
  "${taglib_SOURCE_DIR}/taglib/ape"
  "${taglib_SOURCE_DIR}/taglib/mp4"
)
target_link_libraries(music-tags-file PRIVATE tag "-framework Foundation" "-framework AudioToolbox" "-framework AVFoundation")
