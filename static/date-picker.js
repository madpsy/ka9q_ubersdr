// Date Picker Component for Noise Floor Monitor
class DatePicker {
    constructor(availableDates, onDateSelect, currentDate = null) {
        this.availableDates = new Set(availableDates);
        this.onDateSelect = onDateSelect;
        this.currentDate = currentDate;
        this.viewDate = currentDate ? new Date(currentDate) : new Date();
        this.selectedDate = currentDate;
        
        this.monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];
        this.dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    }

    show() {
        const overlay = document.getElementById('datePickerOverlay');
        overlay.classList.add('active');
        this.render();
        this.setupEventListeners();
    }

    close() {
        const overlay = document.getElementById('datePickerOverlay');
        overlay.classList.remove('active');
    }

    setupEventListeners() {
        const prevBtn = document.getElementById('prevMonth');
        const nextBtn = document.getElementById('nextMonth');
        
        prevBtn.onclick = () => {
            this.viewDate.setMonth(this.viewDate.getMonth() - 1);
            this.render();
        };
        
        nextBtn.onclick = () => {
            this.viewDate.setMonth(this.viewDate.getMonth() + 1);
            this.render();
        };

        // Close on overlay click
        const overlay = document.getElementById('datePickerOverlay');
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                this.close();
            }
        };
    }

    render() {
        const monthYearDisplay = document.getElementById('monthYearDisplay');
        const calendar = document.getElementById('datePickerCalendar');
        
        // Update month/year display
        monthYearDisplay.textContent = `${this.monthNames[this.viewDate.getMonth()]} ${this.viewDate.getFullYear()}`;
        
        // Clear calendar
        calendar.innerHTML = '';
        
        // Add day headers
        this.dayNames.forEach(day => {
            const header = document.createElement('div');
            header.className = 'date-picker-day-header';
            header.textContent = day;
            calendar.appendChild(header);
        });
        
        // Get first day of month and number of days
        const year = this.viewDate.getFullYear();
        const month = this.viewDate.getMonth();
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        // Add empty cells for days before month starts
        for (let i = 0; i < firstDay; i++) {
            const emptyDay = document.createElement('div');
            emptyDay.className = 'date-picker-day empty';
            calendar.appendChild(emptyDay);
        }
        
        // Add days of month
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayEl = document.createElement('div');
            dayEl.className = 'date-picker-day';
            dayEl.textContent = day;
            
            // Check if date has data available
            if (this.availableDates.has(dateStr)) {
                dayEl.classList.add('available');
                dayEl.onclick = () => {
                    this.selectedDate = dateStr;
                    this.onDateSelect(dateStr);
                    this.close();
                };
            } else {
                dayEl.classList.add('disabled');
            }
            
            // Highlight selected date
            if (dateStr === this.selectedDate) {
                dayEl.classList.add('selected');
            }
            
            calendar.appendChild(dayEl);
        }
        
        // Update navigation buttons
        this.updateNavButtons();
    }

    updateNavButtons() {
        const prevBtn = document.getElementById('prevMonth');
        const nextBtn = document.getElementById('nextMonth');
        
        // Find earliest and latest available dates
        const dates = Array.from(this.availableDates).sort();
        if (dates.length === 0) {
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            return;
        }
        
        const earliest = new Date(dates[0]);
        const latest = new Date(dates[dates.length - 1]);
        
        // Disable prev if we're at or before earliest month
        const viewYear = this.viewDate.getFullYear();
        const viewMonth = this.viewDate.getMonth();
        prevBtn.disabled = (viewYear < earliest.getFullYear()) || 
                          (viewYear === earliest.getFullYear() && viewMonth <= earliest.getMonth());
        
        // Disable next if we're at or after latest month
        nextBtn.disabled = (viewYear > latest.getFullYear()) || 
                          (viewYear === latest.getFullYear() && viewMonth >= latest.getMonth());
    }

    updateAvailableDates(dates) {
        this.availableDates = new Set(dates);
        if (document.getElementById('datePickerOverlay').classList.contains('active')) {
            this.render();
        }
    }
}