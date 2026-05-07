Name the City database file GeoLite2-Country.mmdb even if it's the City database for simplicity (otherwise the config path and dockerfile would need changed)

The ASN database should be named GeoLite2-ASN.mmdb

Both files should not be uploaded to Github.

docker.sh will automatically download both databases using the license key in licence.txt
