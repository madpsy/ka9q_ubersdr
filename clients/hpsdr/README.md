ka9q_hpsdr translates ka9q-radio channel data in to protocol2 hpsdr
data and sent via ethernet UDP packets. Protocol2 is defined in this
document: https://github.com/TAPR/OpenHPSDR-Firmware/blob/master/Protocol%202/Documentation/openHPSDR%20Ethernet%20Protocol%20v4.3.pdf

ka9q_hpsdr currently supports up to 8 receiver channels from ka9q-radio
defined by MAX_RCVRS. This is per instantiation of ka9q_hpsdr. You can
run another copy of ka9q_hpsdr for up to 16 receiver channels.

The 2nd instance can run on a physical or a virtual net interface, as long
as it's not being used by the 1st instance. These are the 
steps I used to create a virtual interface:

**Create a virtual interface eno1.1 with a unique MAC on physical eno1**

sudo ip link add link eno1 address 00:1C:C0:A2:10:DE eno1.1 type macvlan

**Bring it up and assign an IP**

sudo ip link set dev eno1.1 up

**For dhcp assign IP**

sudo dhcpcd eno1.1

**or**

sudo dhclient -v eno1.1

**Or static IP**

sudo ip addr add 192.168.1.100/24 dev eno1.1

I put this together to be able to use my RX-888Mk2 for CW skimming.

You can find instructions on how to set up for running two instances 
of SkimSrv by googling:

running 2 instances of skimsrv

Hopefully this program will help RX888 owners run hpsdr friendly programs
that can handle multiple receiver slices for skimming cw, ft8, and other modes.

Examples:

https://www.sparksdr.com

https://www.dxatlas.com/SkimServer

https://www.dxatlas.com/RttySkimServ

https://github.com/g0orx/linhpsdr

https://github.com/ramdor/Thetis/releases

https://github.com/dl1ycf/pihpsdr

A sample configuration file 'radiod@rx888-hf.conf' is included for an RX888.

I run ka9q_hpsdr on the same PC as ka9q-radio and in a top level directory along
side ka9q-radio. If ka9q-radio isn't in an adjacent directory, needed source
code from ka9q-radio is used from the ALT_SRC directory.

I made a small patch that modifies rx888.c to write 16k of raw ADC samples
every 66ms to a ramdisk. That data is then used by ka9q_hpsdr to provide a
wideband spectrum for HPSDR programs which implement it. It would be much
better to send it in multicast once I figure out how to do that.

cd ../ka9q-radio

cat ../ka9q_hpsdr/ka9q-radio_wideband.patch | patch -p1

make; make install

If you can suggest improvements or find bugs please post something to the Issues
tab on https://github.com/n1gp/ka9q_hpsdr

Issues:

Rarely I have seen that when initializing the channel, the high and low filters
get set to 5KHz and -5KHz. I'm guessing that the control packet with the proper
settings didn't make it to ka9q-radio.

When switching sample rates there may be no data coming from pcmrecord for a few
seconds or more, or not at all if the rate is above 192k unless I add 100 Hz.
I'm not sure where the problem lies.

Screenshots:

<img width="283" height="275" alt="thetis" src="https://github.com/user-attachments/assets/0d5da337-150c-4b89-ad53-f9e6a51db5cd" />
<img width="413" height="235" alt="sparksdr" src="https://github.com/user-attachments/assets/881db0bb-49f9-48f6-b034-8fb5e906c91e" />
<img width="290" height="245" alt="SkimSrvx2" src="https://github.com/user-attachments/assets/4aaa8617-36c8-4b22-959f-8c83c787387c" />


