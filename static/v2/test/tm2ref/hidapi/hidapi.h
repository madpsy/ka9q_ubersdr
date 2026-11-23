/* Stand-in for hidapi, so tmate2.c compiles without a device: tm2gen.c only
 * calls the functions that fill the frame, never the ones that talk USB. */
typedef struct hid_device_ hid_device;
hid_device *hid_open(unsigned short, unsigned short, const void *);
int hid_read(hid_device *, unsigned char *, int);
int hid_write(hid_device *, const unsigned char *, int);
void hid_close(hid_device *);
