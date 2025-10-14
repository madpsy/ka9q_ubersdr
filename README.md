radiod build:

`sudo apt install libbsd-dev libiniparser-dev  libopus-dev libavahi-client-dev libavahi-common-dev  libavahi-client-dev libavahi-common-dev libncurses5-dev libncursesw5-dev libportaudio2 portaudio19-dev libsamplerate0 libsamplerate0-dev libogg-dev libvorbis-dev libogg-dev libvorbis-dev libairspyhf-dev libairspy-dev librtlsdr-dev libfftw3-dev uuid-dev avahi-utils`

`cd ka9q-radio`
`make`
`sudo make install`

`sudo fftwf-wisdom -v -T 1 -o /var/lib/ka9q-radio/wisdom rof500000 cof36480 cob1920 cob1200 cob960 cob800 cob600 cob480 cob320 cob300 cob200 cob160`

`radiod radiod-rx888.conf`

To build ubersdr:

`cd ..`
`make` 

Needs Golang installed.

`cp config.yaml.example config.yaml`
`cp bands.yaml.example bands.yaml`
`cp bookmarks.yaml.example bookmarks.yaml`

change admin admin in config.yaml

`./ka9q_ubersdr`
