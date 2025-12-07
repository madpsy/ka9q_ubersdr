/**
 * Maidenhead Locator System Converter
 * Converts latitude/longitude coordinates to Maidenhead grid square locators
 * 
 * The Maidenhead Locator System is a geographic coordinate system used by amateur radio operators.
 * It divides the world into a grid of squares identified by a combination of letters and numbers.
 * 
 * Format: AA00aa (6 characters) or AA00 (4 characters)
 * - First pair (AA): Field (20° longitude × 10° latitude)
 * - Second pair (00): Square (2° longitude × 1° latitude)
 * - Third pair (aa): Subsquare (5' longitude × 2.5' latitude)
 */

/**
 * Convert latitude and longitude to Maidenhead locator
 * @param {number} lat - Latitude in decimal degrees (-90 to 90)
 * @param {number} lon - Longitude in decimal degrees (-180 to 180)
 * @param {number} precision - Number of character pairs (1-3, default 3 for 6-char locator)
 * @returns {string} Maidenhead locator string (e.g., "FN42ab")
 */
function latLonToMaidenhead(lat, lon, precision = 3) {
    // Validate inputs
    if (typeof lat !== 'number' || typeof lon !== 'number') {
        throw new Error('Latitude and longitude must be numbers');
    }
    
    if (lat < -90 || lat > 90) {
        throw new Error('Latitude must be between -90 and 90 degrees');
    }
    
    if (lon < -180 || lon > 180) {
        throw new Error('Longitude must be between -180 and 180 degrees');
    }
    
    if (precision < 1 || precision > 3) {
        throw new Error('Precision must be between 1 and 3');
    }
    
    // Adjust coordinates to be relative to the grid origin
    // Maidenhead grid starts at 180°W, 90°S
    let adjustedLon = lon + 180;
    let adjustedLat = lat + 90;
    
    let locator = '';
    
    // Calculate field (first pair - letters A-R)
    const fieldLon = Math.floor(adjustedLon / 20);
    const fieldLat = Math.floor(adjustedLat / 10);
    locator += String.fromCharCode(65 + fieldLon); // A-R
    locator += String.fromCharCode(65 + fieldLat);
    
    if (precision < 2) {
        return locator;
    }
    
    // Calculate square (second pair - digits 0-9)
    adjustedLon = adjustedLon % 20;
    adjustedLat = adjustedLat % 10;
    const squareLon = Math.floor(adjustedLon / 2);
    const squareLat = Math.floor(adjustedLat / 1);
    locator += squareLon.toString();
    locator += squareLat.toString();
    
    if (precision < 3) {
        return locator;
    }
    
    // Calculate subsquare (third pair - letters a-x)
    adjustedLon = adjustedLon % 2;
    adjustedLat = adjustedLat % 1;
    const subsquareLon = Math.floor(adjustedLon / (2/24));
    const subsquareLat = Math.floor(adjustedLat / (1/24));
    locator += String.fromCharCode(97 + subsquareLon); // a-x (lowercase)
    locator += String.fromCharCode(97 + subsquareLat);
    
    return locator;
}

/**
 * Convert Maidenhead locator to approximate center coordinates
 * @param {string} locator - Maidenhead locator (e.g., "FN42ab")
 * @returns {object} Object with lat and lon properties
 */
function maidenheadToLatLon(locator) {
    if (typeof locator !== 'string') {
        throw new Error('Locator must be a string');
    }
    
    locator = locator.toUpperCase();
    
    // Validate format
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(locator)) {
        throw new Error('Invalid Maidenhead locator format');
    }
    
    let lon = -180;
    let lat = -90;
    
    // Decode field (first pair)
    lon += (locator.charCodeAt(0) - 65) * 20;
    lat += (locator.charCodeAt(1) - 65) * 10;
    
    // Decode square (second pair)
    lon += parseInt(locator[2]) * 2;
    lat += parseInt(locator[3]) * 1;
    
    // Decode subsquare if present (third pair)
    if (locator.length >= 6) {
        lon += (locator.charCodeAt(4) - 65) * (2/24);
        lat += (locator.charCodeAt(5) - 65) * (1/24);
        
        // Return center of subsquare
        lon += (2/24) / 2;
        lat += (1/24) / 2;
    } else {
        // Return center of square
        lon += 1;
        lat += 0.5;
    }
    
    return {
        lat: Math.round(lat * 1000000) / 1000000,
        lon: Math.round(lon * 1000000) / 1000000
    };
}

/**
 * Calculate distance between two Maidenhead locators in kilometers
 * Uses the Haversine formula
 * @param {string} locator1 - First Maidenhead locator
 * @param {string} locator2 - Second Maidenhead locator
 * @returns {number} Distance in kilometers
 */
function maidenheadDistance(locator1, locator2) {
    const coord1 = maidenheadToLatLon(locator1);
    const coord2 = maidenheadToLatLon(locator2);
    
    const R = 6371; // Earth's radius in kilometers
    const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
    const dLon = (coord2.lon - coord1.lon) * Math.PI / 180;
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return Math.round(distance * 100) / 100;
}

// Export functions for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        latLonToMaidenhead,
        maidenheadToLatLon,
        maidenheadDistance
    };
}