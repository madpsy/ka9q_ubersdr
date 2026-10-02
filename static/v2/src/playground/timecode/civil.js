// Calendar arithmetic the time-code decoders and their voter share: days since
// 1970, day of year, a time's fields carried forward by whole minutes, and
// whether a leap second could follow a minute. UTC throughout; two-digit years
// are 2000 + yy, as every station's code is read here.

/** Days from 1970-01-01 to y-m-d (proleptic Gregorian; Hinnant's days_from_civil). */
export function daysFromCivil(y, m, d) {
    const yy = m <= 2 ? y - 1 : y;
    const era = Math.floor(yy / 400);
    const yoe = yy - era * 400;
    const mp = (m + 9) % 12;
    const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

/** y-m-d from days since 1970-01-01. */
export function civilFromDays(z) {
    const zz = z + 719468;
    const era = Math.floor(zz / 146097);
    const doe = zz - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return { y: m <= 2 ? y + 1 : y, m, d };
}

export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInYear = (y) => (isLeapYear(y) ? 366 : 365);
export const daysInMonth = (y, m) => [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Whether y-m-d is a real date. */
export function validDate(y, m, d) {
    return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Day of year (1-based) of y-m-d. */
export function dayOfYear(y, m, d) {
    return daysFromCivil(y, m, d) - daysFromCivil(y, 1, 1) + 1;
}

/** Unix ms of a time given as (minute, hour, day of year, two-digit year). */
export function utcFromFields({ minute, hour, doy, year2 }) {
    const days = daysFromCivil(2000 + year2, 1, 1) + doy - 1;
    return ((days * 24 + hour) * 60 + minute) * 60000;
}

/** (minute, hour, day of year, two-digit year) of a Unix ms (whole minutes). */
export function fieldsFromUtc(ms) {
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const { y } = civilFromDays(days);
    return {
        minute: ((mins % 60) + 60) % 60,
        hour: Math.floor((((mins % 1440) + 1440) % 1440) / 60),
        doy: days - daysFromCivil(y, 1, 1) + 1,
        year2: ((y - 2000) % 100 + 100) % 100,
    };
}

/** A time's fields `n` minutes on, carrying minute → hour → day → year (mod 100). */
export function advanceMinutes(f, n) {
    if (!n) return { ...f };
    return fieldsFromUtc(utcFromFields(f) + n * 60000);
}

/** Whether fields are in range: minute 0–59, hour 0–23, day 1–365 (366 in a leap year), year 0–99. */
export function fieldsValid(f) {
    return f.minute >= 0 && f.minute <= 59 && f.hour >= 0 && f.hour <= 23
        && f.year2 >= 0 && f.year2 <= 99
        && f.doy >= 1 && f.doy <= daysInYear(2000 + f.year2);
}

/**
 * Whether a leap second could follow the minute `f`: it is 23:59 UTC on the
 * last day of a month. Unknown (null) counts as possible, as the decoders take
 * it.
 */
export function leapSecondPossible(f) {
    if (!f) return true;
    if (f.hour !== 23 || f.minute !== 59) return false;
    const days = daysFromCivil(2000 + f.year2, 1, 1) + f.doy - 1;
    const { y, m, d } = civilFromDays(days);
    return d === daysInMonth(y, m);
}

/**
 * Whether European summer time is in force at Unix ms `ms`: from 01:00 UTC on
 * the last Sunday of March to 01:00 UTC on the last Sunday of October.
 */
export function euSummerTime(ms) {
    const { y } = civilFromDays(Math.floor(ms / 86400000));
    const lastSunday = (m) => {
        const last = daysFromCivil(y, m, daysInMonth(y, m));
        const wd = ((last + 4) % 7 + 7) % 7; // 0 = Sunday
        return last - wd;
    };
    const start = lastSunday(3) * 86400000 + 3600000;
    const end = lastSunday(10) * 86400000 + 3600000;
    return ms >= start && ms < end;
}
