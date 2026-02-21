// resource.h - Resource IDs for UberSDRMonitor

#ifndef RESOURCE_H
#define RESOURCE_H

#ifndef IDC_STATIC
#define IDC_STATIC (-1)
#endif

#define IDD_MAIN                        101
#define IDC_SERVER_STATUS               1001
#define IDC_SAMPLE_RATE                 1002
#define IDC_MODE                        1003
#define IDC_RX0_STATUS                  1010
#define IDC_RX1_STATUS                  1011
#define IDC_RX2_STATUS                  1012
#define IDC_RX3_STATUS                  1013
#define IDC_RX4_STATUS                  1014
#define IDC_RX5_STATUS                  1015
#define IDC_RX6_STATUS                  1016
#define IDC_RX7_STATUS                  1017
#define IDC_CALLBACKS                   1020
#define IDC_UPTIME                      1021
#define IDC_TOTAL_THROUGHPUT            1022

// Level meter progress bars (I and Q channels for each receiver)
#define IDC_RX0_LEVEL_I                 1030
#define IDC_RX0_LEVEL_Q                 1031
#define IDC_RX1_LEVEL_I                 1032
#define IDC_RX1_LEVEL_Q                 1033
#define IDC_RX2_LEVEL_I                 1034
#define IDC_RX2_LEVEL_Q                 1035
#define IDC_RX3_LEVEL_I                 1036
#define IDC_RX3_LEVEL_Q                 1037
#define IDC_RX4_LEVEL_I                 1038
#define IDC_RX4_LEVEL_Q                 1039
#define IDC_RX5_LEVEL_I                 1040
#define IDC_RX5_LEVEL_Q                 1041
#define IDC_RX6_LEVEL_I                 1042
#define IDC_RX6_LEVEL_Q                 1043
#define IDC_RX7_LEVEL_I                 1044
#define IDC_RX7_LEVEL_Q                 1045

// Record buttons for each receiver
#define IDC_RX0_RECORD                  1050
#define IDC_RX1_RECORD                  1051
#define IDC_RX2_RECORD                  1052
#define IDC_RX3_RECORD                  1053
#define IDC_RX4_RECORD                  1054
#define IDC_RX5_RECORD                  1055
#define IDC_RX6_RECORD                  1056
#define IDC_RX7_RECORD                  1057

// Spectrum buttons for each receiver
#define IDC_RX0_SPECTRUM                1058
#define IDC_RX1_SPECTRUM                1059
#define IDC_RX2_SPECTRUM                1060
#define IDC_RX3_SPECTRUM                1061
#define IDC_RX4_SPECTRUM                1062
#define IDC_RX5_SPECTRUM                1063
#define IDC_RX6_SPECTRUM                1064
#define IDC_RX7_SPECTRUM                1065

// Telnet controls
#define IDC_TELNET_OUTPUT               1070
#define IDC_TELNET_PORT                 1071
#define IDC_TELNET_CONNECT              1072
#define IDC_TELNET_DISCONNECT           1073

// DX Spot counters for each receiver
#define IDC_RX0_SPOTS                   1090
#define IDC_RX1_SPOTS                   1091
#define IDC_RX2_SPOTS                   1092
#define IDC_RX3_SPOTS                   1093
#define IDC_RX4_SPOTS                   1094
#define IDC_RX5_SPOTS                   1095
#define IDC_RX6_SPOTS                   1096
#define IDC_RX7_SPOTS                   1097

// Instance list controls
#define IDC_INSTANCE_LIST               1080
#define IDC_INSTANCE_LABEL              1081
#define IDC_CONNECT_BUTTON              1082

// Spots window buttons for each receiver
#define IDC_RX0_SPOTS_BTN               1100
#define IDC_RX1_SPOTS_BTN               1101
#define IDC_RX2_SPOTS_BTN               1102
#define IDC_RX3_SPOTS_BTN               1103
#define IDC_RX4_SPOTS_BTN               1104
#define IDC_RX5_SPOTS_BTN               1105
#define IDC_RX6_SPOTS_BTN               1106
#define IDC_RX7_SPOTS_BTN               1107

// Duration edit boxes for each receiver (in seconds, 0 = hold-to-record mode)
#define IDC_RX0_DURATION                1110
#define IDC_RX1_DURATION                1111
#define IDC_RX2_DURATION                1112
#define IDC_RX3_DURATION                1113
#define IDC_RX4_DURATION                1114
#define IDC_RX5_DURATION                1115
#define IDC_RX6_DURATION                1116
#define IDC_RX7_DURATION                1117

// Median offset display for each receiver
#define IDC_RX0_MEDIAN                  1120
#define IDC_RX1_MEDIAN                  1121
#define IDC_RX2_MEDIAN                  1122
#define IDC_RX3_MEDIAN                  1123
#define IDC_RX4_MEDIAN                  1124
#define IDC_RX5_MEDIAN                  1125
#define IDC_RX6_MEDIAN                  1126
#define IDC_RX7_MEDIAN                  1127

// Spectrum window dialog
#define IDD_SPECTRUM                    102

#endif // RESOURCE_H
