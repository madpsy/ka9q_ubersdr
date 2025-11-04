// Date Picker Component for Noise Floor Monitor
class DatePicker {
    constructor(availableDates, onDateSelect, currentDate = null, options = {}) {
        this.availableDates = new Set(availableDates);
        this.onDateSelect = onDateSelect;
        this.currentDate = currentDate;
        this.viewDate = currentDate ? new Date(currentDate) : new Date();
        this.selectedDate = currentDate;

        // Options for time support
        this.includeTime = options.includeTime || false;
        this.selectedTime = options.defaultTime || '00:00';

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
            
            // Check if date has data available (or allow all dates if no available dates specified)
            const hasData = this.availableDates.size === 0 || this.availableDates.has(dateStr);
            if (hasData) {
                dayEl.classList.add('available');
                dayEl.onclick = () => {
                    this.selectedDate = dateStr;
                    if (this.includeTime) {
                        // Don't close yet, let user select time
                        this.render();
                    } else {
                        this.onDateSelect(dateStr);
                        this.close();
                    }
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
        
        // Add time picker if enabled and date is selected
        if (this.includeTime && this.selectedDate) {
            this.renderTimePicker();
        }

        // Update navigation buttons
        this.updateNavButtons();
    }

    renderTimePicker() {
        const calendar = document.getElementById('datePickerCalendar');

        // Create time picker row
        const timeRow = document.createElement('div');
        timeRow.style.gridColumn = '1 / -1';
        timeRow.style.marginTop = '15px';
        timeRow.style.padding = '15px';
        timeRow.style.background = 'rgba(255, 255, 255, 0.1)';
        timeRow.style.borderRadius = '8px';
        timeRow.style.display = 'flex';
        timeRow.style.flexDirection = 'column';
        timeRow.style.gap = '10px';

        const timeLabel = document.createElement('div');
        timeLabel.textContent = 'Select Time:';
        timeLabel.style.fontWeight = 'bold';
        timeLabel.style.marginBottom = '5px';

        const timeInputContainer = document.createElement('div');
        timeInputContainer.style.display = 'flex';
        timeInputContainer.style.gap = '10px';
        timeInputContainer.style.alignItems = 'center';

        // Hour input
        const hourInput = document.createElement('input');
        hourInput.type = 'number';
        hourInput.min = '0';
        hourInput.max = '23';
        hourInput.value = this.selectedTime.split(':')[0];
        hourInput.style.width = '60px';
        hourInput.style.padding = '8px';
        hourInput.style.borderRadius = '5px';
        hourInput.style.border = 'none';
        hourInput.style.textAlign = 'center';
        hourInput.style.fontSize = '1.1em';

        const colon = document.createElement('span');
        colon.textContent = ':';
        colon.style.fontSize = '1.5em';
        colon.style.fontWeight = 'bold';

        // Minute input
        const minuteInput = document.createElement('input');
        minuteInput.type = 'number';
        minuteInput.min = '0';
        minuteInput.max = '59';
        minuteInput.value = this.selectedTime.split(':')[1];
        minuteInput.style.width = '60px';
        minuteInput.style.padding = '8px';
        minuteInput.style.borderRadius = '5px';
        minuteInput.style.border = 'none';
        minuteInput.style.textAlign = 'center';
        minuteInput.style.fontSize = '1.1em';

        // Confirm button
        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirm';
        confirmBtn.style.marginLeft = 'auto';
        confirmBtn.style.padding = '8px 16px';
        confirmBtn.onclick = () => {
            const hour = String(parseInt(hourInput.value) || 0).padStart(2, '0');
            const minute = String(parseInt(minuteInput.value) || 0).padStart(2, '0');
            this.selectedTime = `${hour}:${minute}`;
            const dateTime = `${this.selectedDate}T${this.selectedTime}:00`;
            this.onDateSelect(dateTime);
            this.close();
        };

        timeInputContainer.appendChild(hourInput);
        timeInputContainer.appendChild(colon);
        timeInputContainer.appendChild(minuteInput);
        timeInputContainer.appendChild(confirmBtn);

        timeRow.appendChild(timeLabel);
        timeRow.appendChild(timeInputContainer);
        calendar.appendChild(timeRow);
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