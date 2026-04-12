// S-Meter with Needle - Classic analog-style signal strength meter
// Displays signal strength using a rotating needle on an arc scale
// Click the canvas to toggle between S-meter and SNR mode

class SMeterNeedle {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error(`S-Meter canvas not found: ${canvasId}`);
            return;
        }

        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        // Center point for the meter - positioned at bottom for semicircle
        this.centerX = this.width / 2;
        this.centerY = this.height - 20; // 20px from bottom for labels

        // Meter dimensions - sized to fit within canvas bounds
        this.radius = Math.min(this.width / 2.2, this.height - 30);
        this.needleLength = this.radius - 18;

        // Display mode: 'smeter' or 'snr'
        this.displayMode = 'smeter';

        // Signal values
        this.currentValue = -120; // dBFS
        this.targetValue = -120;
        this.originalValue = -120; // Store unclamped value for display
        this.needleAngle = this.getAngleForValue(-120);

        // SNR tracking
        this.currentSNR = null; // null means no data yet
        this.snrNeedleValue = 30; // smoothed SNR for needle (starts at min)
        this.snrNeedleTarget = 30;

        // Peak hold values
        this.peakValue = -120; // dBFS
        this.originalPeakValue = -120; // Store unclamped peak value for display
        this.peakAngle = this.getAngleForValue(-120);
        this.peakDecayRate = 1.0; // dB per frame to decay
        this.peakHoldTime = 15; // frames to hold peak before decay (0.5s at 30fps)
        this.peakHoldCounter = 0;

        // Animation settings
        this.animationSpeed = 0.6;

        // S-meter scale configuration
        // S1 = -115 dBFS, S9 = -73 dBFS (6 dB per S-unit)
        // S9+10 = -63, S9+20 = -53, S9+30 = -43, S9+40 = -33
        this.minDb = -127;
        this.maxDb = -33;

        // SNR scale configuration (30–60 dB)
        this.snrMin = 30;
        this.snrMax = 60;

        // Start angle (left) and end angle (right) in radians
        this.startAngle = Math.PI; // 180 degrees (left)
        this.endAngle = 0;         // 0 degrees (right)
        this.angleRange = this.startAngle - this.endAngle;

        // Click handler to toggle display mode
        this.canvas.style.cursor = 'pointer';
        this.canvas.title = 'Click to toggle S-Meter / SNR mode';
        this.canvas.addEventListener('click', () => this.toggleDisplayMode());

        // Initial draw
        this.draw();
    }

    // Toggle between S-meter and SNR display modes
    toggleDisplayMode() {
        this.displayMode = this.displayMode === 'smeter' ? 'snr' : 'smeter';
        this.draw();
    }

    // Convert dBFS to S-units for display
    dbfsToSUnits(dbfs) {
        if (dbfs < -115) return 0;
        if (dbfs < -73) {
            return 1 + (dbfs + 115) / 6;
        }
        return 9 + (dbfs + 73) / 10;
    }

    // Format S-units as string (e.g., "S4", "S9+7")
    formatSUnits(dbfs) {
        const sUnits = this.dbfsToSUnits(dbfs);

        if (sUnits < 1) {
            return 'S0';
        } else if (sUnits <= 9) {
            return 'S' + Math.round(sUnits);
        } else {
            const overS9 = Math.round((dbfs + 73));
            return 'S9+' + overS9;
        }
    }

    // Convert dBFS value to angle for the needle
    getAngleForValue(dbfs) {
        const clampedDb = Math.max(this.minDb, Math.min(this.maxDb, dbfs));
        const normalized = (clampedDb - this.minDb) / (this.maxDb - this.minDb);
        return this.endAngle + (normalized * this.angleRange);
    }

    // Convert dBFS value to angle for scale labels (not inverted)
    getScaleLabelAngle(dbfs) {
        const clampedDb = Math.max(this.minDb, Math.min(this.maxDb, dbfs));
        const normalized = (clampedDb - this.minDb) / (this.maxDb - this.minDb);
        return this.startAngle - (normalized * this.angleRange);
    }

    // Convert SNR value (30–80 dB) to needle angle
    getAngleForSNR(snr) {
        const clamped = Math.max(this.snrMin, Math.min(this.snrMax, snr));
        const normalized = (clamped - this.snrMin) / (this.snrMax - this.snrMin);
        return this.endAngle + (normalized * this.angleRange);
    }

    // Convert SNR value to scale label angle (not inverted)
    getScaleLabelAngleForSNR(snr) {
        const clamped = Math.max(this.snrMin, Math.min(this.snrMax, snr));
        const normalized = (clamped - this.snrMin) / (this.snrMax - this.snrMin);
        return this.startAngle - (normalized * this.angleRange);
    }

    // Graduated SNR colour (red ≤30 dB → green ≥50 dB)
    snrColour(snr) {
        const snrClamped = Math.max(30, Math.min(50, snr));
        const hue = Math.round(((snrClamped - 30) / 20) * 120);
        return `hsl(${hue}, 90%, 55%)`;
    }

    // Graduated S-meter colour (red at S1/−115 dBFS → yellow at S5/−91 dBFS → green at S9/−73 dBFS)
    sMeterColour(dbfs) {
        const clamped = Math.max(-115, Math.min(-73, dbfs));
        const hue = Math.round(((clamped + 115) / 42) * 120);
        return `hsl(${hue}, 90%, 55%)`;
    }

    // Draw the complete meter
    draw() {
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.drawBackground();
        this.drawScale();
        this.drawPeakNeedle();
        this.drawNeedle();
        this.drawPivot();
        this.updateValueDisplay();
    }

    // Draw the meter background arc
    drawBackground() {
        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, this.radius, this.endAngle, this.startAngle, false);
        this.ctx.strokeStyle = '#34495e';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
    }

    // Draw scale markings and labels (branches on displayMode)
    drawScale() {
        if (this.displayMode === 'snr') {
            this.drawScaleSNR();
        } else {
            this.drawScaleSMeter();
        }
    }

    // Draw S-meter scale (S1–S9, +10/+20/+30/+40)
    drawScaleSMeter() {
        this.ctx.font = 'bold 13px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // S-unit markers S1–S9
        for (let s = 1; s <= 9; s++) {
            const dbfs = -115 + (s - 1) * 6;
            const angle = this.getScaleLabelAngle(dbfs);
            const col = this.sMeterColour(dbfs);

            const tickStart = this.radius - 15;
            const tickEnd = this.radius - 5;
            const labelRadius = this.radius - 25;

            const x1 = this.centerX + Math.cos(angle) * tickStart;
            const y1 = this.centerY - Math.sin(angle) * tickStart;
            const x2 = this.centerX + Math.cos(angle) * tickEnd;
            const y2 = this.centerY - Math.sin(angle) * tickEnd;

            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.strokeStyle = col;
            this.ctx.lineWidth = 2;
            this.ctx.stroke();

            const labelX = this.centerX + Math.cos(angle) * labelRadius;
            const labelY = this.centerY - Math.sin(angle) * labelRadius;
            this.ctx.fillStyle = col;
            this.ctx.fillText(s.toString(), labelX, labelY);
        }

        // Over S9 markers (+10, +20, +30, +40) — all above S9 so full green
        const overS9 = [10, 20, 30, 40];
        const greenCol = this.sMeterColour(-73);
        for (const db of overS9) {
            const dbfs = -73 + db;
            const angle = this.getScaleLabelAngle(dbfs);

            const tickStart = this.radius - 12;
            const tickEnd = this.radius - 5;
            const labelRadius = this.radius - 25;

            const x1 = this.centerX + Math.cos(angle) * tickStart;
            const y1 = this.centerY - Math.sin(angle) * tickStart;
            const x2 = this.centerX + Math.cos(angle) * tickEnd;
            const y2 = this.centerY - Math.sin(angle) * tickEnd;

            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.strokeStyle = greenCol;
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();

            const labelX = this.centerX + Math.cos(angle) * labelRadius;
            const labelY = this.centerY - Math.sin(angle) * labelRadius;
            this.ctx.fillStyle = greenCol;
            this.ctx.font = 'bold 10px Arial';
            this.ctx.fillText(`+${db}`, labelX, labelY);
        }

        // "S" label at bottom left
        this.ctx.font = 'bold 12px Arial';
        this.ctx.fillStyle = '#ecf0f1';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('S', 10, this.height - 10);

        // "dB" label at bottom right
        this.ctx.textAlign = 'right';
        this.ctx.fillText('dB', this.width - 10, this.height - 10);
    }

    // Draw SNR scale (30–60 dB, major ticks with labels at every 5 dB)
    drawScaleSNR() {
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // Major ticks with labels at every 5 dB (30, 35, 40, 45, 50, 55, 60)
        for (let snr = 30; snr <= 60; snr += 5) {
            const angle = this.getScaleLabelAngleForSNR(snr);
            const tickStart = this.radius - 15;
            const tickEnd = this.radius - 5;
            const labelRadius = this.radius - 27;

            const x1 = this.centerX + Math.cos(angle) * tickStart;
            const y1 = this.centerY - Math.sin(angle) * tickStart;
            const x2 = this.centerX + Math.cos(angle) * tickEnd;
            const y2 = this.centerY - Math.sin(angle) * tickEnd;

            const col = this.snrColour(snr);

            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.strokeStyle = col;
            this.ctx.lineWidth = 2;
            this.ctx.stroke();

            const labelX = this.centerX + Math.cos(angle) * labelRadius;
            const labelY = this.centerY - Math.sin(angle) * labelRadius;
            this.ctx.fillStyle = col;
            this.ctx.font = 'bold 11px Arial';
            this.ctx.fillText(snr.toString(), labelX, labelY);
        }

        // "SNR" label at bottom left
        this.ctx.font = 'bold 11px Arial';
        this.ctx.fillStyle = '#ecf0f1';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('SNR', 5, this.height - 10);

        // "dB" label at bottom right
        this.ctx.textAlign = 'right';
        this.ctx.fillText('dB', this.width - 10, this.height - 10);
    }

    // Update the value display divs
    updateValueDisplay() {
        const valueDiv = document.getElementById('s-meter-value-display');
        const peakDiv = document.getElementById('s-meter-peak-display');
        const snrDiv = document.getElementById('s-meter-snr-display');

        if (valueDiv) {
            const sUnitText = this.formatSUnits(this.originalValue);
            valueDiv.textContent = sUnitText;

            const exceedsMax = this.originalValue > -33;
            if (exceedsMax) {
                valueDiv.style.color = '#dc3545';
                valueDiv.classList.add('s-meter-overload');
            } else {
                valueDiv.classList.remove('s-meter-overload');
                valueDiv.style.color = this.sMeterColour(this.currentValue);
            }
        }

        if (peakDiv) {
            const peakText = this.formatSUnits(this.originalPeakValue);
            peakDiv.textContent = peakText;

            const peakExceedsMax = this.originalPeakValue > -33;
            if (peakExceedsMax) {
                peakDiv.classList.add('s-meter-overload');
                peakDiv.style.color = '#dc3545';
            } else {
                peakDiv.classList.remove('s-meter-overload');
                peakDiv.style.color = this.sMeterColour(this.peakValue);
            }
        }

        if (snrDiv) {
            if (this.currentSNR !== null && isFinite(this.currentSNR)) {
                const snrRounded = Math.round(this.currentSNR);
                snrDiv.textContent = snrRounded + ' dB SNR';
                snrDiv.style.color = this.snrColour(this.currentSNR);
            } else {
                snrDiv.textContent = '-- dB SNR';
                snrDiv.style.color = '#ffc107';
            }
        }
    }

    // Draw the peak hold needle
    drawPeakNeedle() {
        // In SNR mode, no peak needle (SNR doesn't have a meaningful peak hold)
        if (this.displayMode === 'snr') return;

        this.ctx.save();
        this.ctx.translate(this.centerX, this.centerY);
        this.ctx.rotate(this.peakAngle - Math.PI / 2);

        this.ctx.beginPath();
        this.ctx.moveTo(0, -this.needleLength);
        this.ctx.lineTo(-2, -10);
        this.ctx.lineTo(0, 0);
        this.ctx.lineTo(2, -10);
        this.ctx.closePath();

        this.ctx.fillStyle = 'rgba(0, 255, 255, 0.6)';
        this.ctx.fill();
        this.ctx.strokeStyle = 'rgba(0, 200, 200, 0.8)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        this.ctx.restore();
    }

    // Draw the main needle
    drawNeedle() {
        this.ctx.save();
        this.ctx.translate(this.centerX, this.centerY);

        const angle = this.displayMode === 'snr'
            ? this.getAngleForSNR(this.snrNeedleValue)
            : this.needleAngle;

        this.ctx.rotate(angle - Math.PI / 2);

        // Needle shadow
        this.ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        this.ctx.shadowBlur = 4;
        this.ctx.shadowOffsetX = 2;
        this.ctx.shadowOffsetY = 2;

        // Needle shape (triangle pointing upward)
        this.ctx.beginPath();
        this.ctx.moveTo(0, -this.needleLength);
        this.ctx.lineTo(-4, -10);
        this.ctx.lineTo(0, 0);
        this.ctx.lineTo(4, -10);
        this.ctx.closePath();

        // Needle colour
        if (this.displayMode === 'snr') {
            this.ctx.fillStyle = this.snrColour(this.snrNeedleValue);
        } else {
            this.ctx.fillStyle = this.sMeterColour(this.currentValue);
        }
        this.ctx.fill();

        this.ctx.strokeStyle = '#2c3e50';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        this.ctx.restore();
    }

    // Draw center pivot point
    drawPivot() {
        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, 8, 0, Math.PI * 2);
        this.ctx.fillStyle = '#34495e';
        this.ctx.fill();
        this.ctx.strokeStyle = '#ecf0f1';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = '#2c3e50';
        this.ctx.fill();
    }

    // Update the meter with a new signal value and optional SNR
    update(dbfsValue, snrValue) {
        if (!this.canvas) return;

        // Store SNR if provided and smooth the SNR needle value
        if (snrValue !== undefined && snrValue !== null) {
            this.currentSNR = snrValue;
            this.snrNeedleTarget = Math.max(this.snrMin, Math.min(this.snrMax, snrValue));
        }
        // Smooth SNR needle movement
        this.snrNeedleValue += (this.snrNeedleTarget - this.snrNeedleValue) * this.animationSpeed;

        // Store original (unclamped) value for display
        this.originalValue = dbfsValue;

        // Clamp input value to valid range for needle position
        this.targetValue = Math.max(this.minDb, Math.min(this.maxDb, dbfsValue));

        // Smooth interpolation for needle movement
        this.currentValue += (this.targetValue - this.currentValue) * this.animationSpeed;

        // Update needle angle from current value
        this.needleAngle = this.getAngleForValue(this.currentValue);

        // Update peak hold
        if (this.currentValue > this.peakValue) {
            this.peakValue = this.currentValue;
            this.originalPeakValue = dbfsValue;
            this.peakAngle = this.getAngleForValue(this.peakValue);
            this.peakHoldCounter = this.peakHoldTime;
        } else {
            if (this.peakHoldCounter > 0) {
                this.peakHoldCounter--;
            } else {
                this.peakValue -= this.peakDecayRate;
                this.originalPeakValue -= this.peakDecayRate;
                if (this.peakValue < this.currentValue) {
                    this.peakValue = this.currentValue;
                    this.originalPeakValue = this.originalValue;
                }
                this.peakAngle = this.getAngleForValue(this.peakValue);
            }
        }

        // Redraw
        this.draw();
    }

    // Reset the meter
    reset() {
        this.currentValue = -120;
        this.targetValue = -120;
        this.originalValue = -120;
        this.needleAngle = this.getAngleForValue(-120);
        this.peakValue = -120;
        this.originalPeakValue = -120;
        this.peakAngle = this.getAngleForValue(-120);
        this.peakHoldCounter = 0;
        this.currentSNR = null;
        this.snrNeedleValue = 30;
        this.snrNeedleTarget = 30;
        this.draw();
    }
}

// Global instance (will be initialized when DOM is ready)
let sMeterNeedle = null;

// Initialize S-meter when DOM is ready
function initSMeterNeedle() {
    sMeterNeedle = new SMeterNeedle('s-meter-canvas');
}
