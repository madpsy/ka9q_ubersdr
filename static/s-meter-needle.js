// S-Meter with Needle - Classic analog-style signal strength meter
// Displays signal strength using a rotating needle on an arc scale

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
        // Radius should fit the semicircle in the canvas height
        this.radius = Math.min(this.width / 2.2, this.height - 30);
        this.needleLength = this.radius - 18;
        
        // Signal values
        this.currentValue = -120; // dBFS
        this.targetValue = -120;
        this.originalValue = -120; // Store unclamped value for display
        this.needleAngle = this.getAngleForValue(-120);
        
        // Peak hold values
        this.peakValue = -120; // dBFS
        this.originalPeakValue = -120; // Store unclamped peak value for display
        this.peakAngle = this.getAngleForValue(-120);
        this.peakDecayRate = 1.0; // dB per frame to decay (faster decay)
        this.peakHoldTime = 15; // frames to hold peak before decay (0.5 seconds at 30fps)
        this.peakHoldCounter = 0;
        
        // Animation settings - faster response for quicker needle movement
        this.animationSpeed = 0.6; // Increased from 0.3 for quicker response
        
        // S-meter scale configuration
        // S1 = -115 dBFS, S9 = -73 dBFS (6 dB per S-unit)
        // S9+10 = -63, S9+20 = -53, S9+30 = -43, S9+40 = -33
        this.minDb = -127; // Start below S1 for meter range
        this.maxDb = -33;
        
        // Start angle (left) and end angle (right) in radians
        // Semicircle: S1 on LEFT, S9+40 on RIGHT
        this.startAngle = Math.PI;      // 180 degrees (left) - S1 position
        this.endAngle = 0;              // 0 degrees (right) - S9+40 position
        this.angleRange = this.startAngle - this.endAngle;
        
        // Initial draw
        this.draw();
    }
    
    // Convert dBFS to S-units for display
    dbfsToSUnits(dbfs) {
        if (dbfs < -115) return 0;
        if (dbfs < -73) {
            // S1 to S9: each S-unit is 6 dB, S1 starts at -115 dBFS
            return 1 + (dbfs + 115) / 6;
        }
        // Above S9: S9+10, S9+20, etc.
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
            // Above S9, show as S9+dB
            const overS9 = Math.round((dbfs + 73));
            return 'S9+' + overS9;
        }
    }
    
    // Convert dBFS value to angle for the needle (inverted)
    getAngleForValue(dbfs) {
        // Clamp value to meter range
        const clampedDb = Math.max(this.minDb, Math.min(this.maxDb, dbfs));
        
        // Normalize to 0-1 range
        // 0 = minDb (-121 dBFS) = weak signal
        // 1 = maxDb (-33 dBFS) = strong signal
        const normalized = (clampedDb - this.minDb) / (this.maxDb - this.minDb);
        
        // Inverted for needle: weak signals go right, strong signals go left
        // Weak signals (normalized=0) → endAngle (RIGHT/0)
        // Strong signals (normalized=1) → startAngle (LEFT/π)
        return this.endAngle + (normalized * this.angleRange);
    }
    
    // Convert dBFS value to angle for scale labels (not inverted)
    getScaleLabelAngle(dbfs) {
        // Clamp value to meter range
        const clampedDb = Math.max(this.minDb, Math.min(this.maxDb, dbfs));
        
        // Normalize to 0-1 range
        const normalized = (clampedDb - this.minDb) / (this.maxDb - this.minDb);
        
        // Not inverted for labels: weak signals on left, strong on right
        // Weak signals (normalized=0) → startAngle (LEFT/π)
        // Strong signals (normalized=1) → endAngle (RIGHT/0)
        return this.startAngle - (normalized * this.angleRange);
    }
    
    // Draw the complete S-meter
    draw() {
        // Clear canvas
        this.ctx.clearRect(0, 0, this.width, this.height);
        
        // Draw meter background
        this.drawBackground();
        
        // Draw scale markings and labels
        this.drawScale();
        
        // Draw the peak needle (behind main needle)
        this.drawPeakNeedle();
        
        // Draw the main needle
        this.drawNeedle();
        
        // Draw center pivot
        this.drawPivot();
        
        // Update the value display div
        this.updateValueDisplay();
    }
    
    // Draw the meter background arc
    drawBackground() {
        // Outer arc - simple semicircle
        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, this.radius, this.endAngle, this.startAngle, false);
        this.ctx.strokeStyle = '#34495e';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();
    }
    
    // Draw scale markings and labels
    drawScale() {
        this.ctx.font = 'bold 13px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        // S-unit markers (S1-S9)
        for (let s = 1; s <= 9; s++) {
            const dbfs = -115 + (s - 1) * 6; // S1 = -115 dBFS, each S-unit is 6 dB
            const angle = this.getScaleLabelAngle(dbfs);
            
            // Major tick mark
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
            this.ctx.strokeStyle = '#ecf0f1';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
            
            // Label
            const labelX = this.centerX + Math.cos(angle) * labelRadius;
            const labelY = this.centerY - Math.sin(angle) * labelRadius;
            this.ctx.fillStyle = '#ecf0f1';
            this.ctx.fillText(s.toString(), labelX, labelY);
        }
        
        // Over S9 markers (+10, +20, +30, +40)
        const overS9 = [10, 20, 30, 40];
        for (const db of overS9) {
            const dbfs = -73 + db;
            const angle = this.getScaleLabelAngle(dbfs);
            
            // Minor tick mark
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
            this.ctx.strokeStyle = '#ecf0f1';
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();
            
            // Label
            const labelX = this.centerX + Math.cos(angle) * labelRadius;
            const labelY = this.centerY - Math.sin(angle) * labelRadius;
            this.ctx.fillStyle = '#ecf0f1';
            this.ctx.font = 'bold 10px Arial';
            this.ctx.fillText(`+${db}`, labelX, labelY);
        }
        
        // "S" label at bottom left (positioned to stay within canvas)
        this.ctx.font = 'bold 12px Arial';
        this.ctx.fillStyle = '#ecf0f1';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('S', 10, this.height - 10);
        
        // "dB" label at bottom right (positioned to stay within canvas)
        this.ctx.textAlign = 'right';
        this.ctx.fillText('dB', this.width - 10, this.height - 10);
    }
    
    // Update the value display divs
    updateValueDisplay() {
        const valueDiv = document.getElementById('s-meter-value-display');
        const peakDiv = document.getElementById('s-meter-peak-display');
        
        if (valueDiv) {
            // Use original (unclamped) value for display
            const sUnitText = this.formatSUnits(this.originalValue);
            valueDiv.textContent = sUnitText;
            
            // Check if signal exceeds S9+40 (-33 dBFS)
            const exceedsMax = this.originalValue > -33;

            if (exceedsMax) {
                // Flash red for signals exceeding S9+40
                valueDiv.style.color = '#dc3545'; // Red
                valueDiv.classList.add('s-meter-overload');
            } else {
                // Remove flashing class
                valueDiv.classList.remove('s-meter-overload');

                // Color the main text based on signal strength (matches main signal meter)
                if (this.currentValue >= -70) {
                    valueDiv.style.color = '#28a745'; // Green - strong signal (>= -70 dBFS)
                } else if (this.currentValue >= -85) {
                    valueDiv.style.color = '#ffc107'; // Yellow - moderate signal (>= -85 dBFS)
                } else {
                    valueDiv.style.color = '#dc3545'; // Red - weak signal (< -85 dBFS)
                }
            }
        }
        
        if (peakDiv) {
            // Use original (unclamped) peak value for display
            const peakText = this.formatSUnits(this.originalPeakValue);
            peakDiv.textContent = peakText;

            // Check if peak exceeds S9+40
            const peakExceedsMax = this.originalPeakValue > -33;

            if (peakExceedsMax) {
                peakDiv.classList.add('s-meter-overload');
                peakDiv.style.color = '#dc3545'; // Red
            } else {
                peakDiv.classList.remove('s-meter-overload');
            }
        }
    }
    
    // Draw the peak hold needle
    drawPeakNeedle() {
        this.ctx.save();
        this.ctx.translate(this.centerX, this.centerY);
        this.ctx.rotate(this.peakAngle - Math.PI / 2);
        
        // Peak needle shape (thinner triangle)
        this.ctx.beginPath();
        this.ctx.moveTo(0, -this.needleLength);
        this.ctx.lineTo(-2, -10);
        this.ctx.lineTo(0, 0);
        this.ctx.lineTo(2, -10);
        this.ctx.closePath();
        
        // Peak needle color - semi-transparent white/cyan
        this.ctx.fillStyle = 'rgba(0, 255, 255, 0.6)';
        this.ctx.fill();
        
        // Peak needle outline
        this.ctx.strokeStyle = 'rgba(0, 200, 200, 0.8)';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
        
        this.ctx.restore();
    }
    
    // Draw the main needle
    drawNeedle() {
        this.ctx.save();
        this.ctx.translate(this.centerX, this.centerY);
        // Rotate by needleAngle - π/2 because needle is drawn pointing up (at -90°)
        // but angle 0 should point right and angle π should point left
        this.ctx.rotate(this.needleAngle - Math.PI / 2);
        
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
        
        // Needle color based on dBFS value (matches main signal meter thresholds exactly)
        if (this.currentValue >= -70) {
            this.ctx.fillStyle = '#28a745'; // Green - strong signal (>= -70 dBFS)
        } else if (this.currentValue >= -85) {
            this.ctx.fillStyle = '#ffc107'; // Yellow - moderate signal (>= -85 dBFS)
        } else {
            this.ctx.fillStyle = '#dc3545'; // Red - weak signal (< -85 dBFS)
        }
        this.ctx.fill();
        
        // Needle outline
        this.ctx.strokeStyle = '#2c3e50';
        this.ctx.lineWidth = 1;
        this.ctx.stroke();
        
        this.ctx.restore();
    }
    
    // Draw center pivot point
    drawPivot() {
        // Outer circle
        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, 8, 0, Math.PI * 2);
        this.ctx.fillStyle = '#34495e';
        this.ctx.fill();
        this.ctx.strokeStyle = '#ecf0f1';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        
        // Inner circle
        this.ctx.beginPath();
        this.ctx.arc(this.centerX, this.centerY, 4, 0, Math.PI * 2);
        this.ctx.fillStyle = '#2c3e50';
        this.ctx.fill();
    }
    
    // Update the meter with a new signal value
    update(dbfsValue) {
        if (!this.canvas) return;
        
        // Store original (unclamped) value for display
        this.originalValue = dbfsValue;

        // Clamp input value to valid range for needle position
        this.targetValue = Math.max(this.minDb, Math.min(this.maxDb, dbfsValue));
        
        // Smooth interpolation for needle movement (matches main signal meter)
        this.currentValue += (this.targetValue - this.currentValue) * this.animationSpeed;
        
        // Update needle angle directly from current value
        this.needleAngle = this.getAngleForValue(this.currentValue);
        
        // Update peak hold
        if (this.currentValue > this.peakValue) {
            // New peak detected
            this.peakValue = this.currentValue;
            this.originalPeakValue = dbfsValue; // Store unclamped peak
            this.peakAngle = this.getAngleForValue(this.peakValue);
            this.peakHoldCounter = this.peakHoldTime;
        } else {
            // Decay peak
            if (this.peakHoldCounter > 0) {
                // Hold peak for specified time
                this.peakHoldCounter--;
            } else {
                // Decay peak value
                this.peakValue -= this.peakDecayRate;
                this.originalPeakValue -= this.peakDecayRate; // Decay unclamped peak too
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
        this.draw();
    }
}

// Global instance (will be initialized when DOM is ready)
let sMeterNeedle = null;

// Initialize S-meter when DOM is ready
function initSMeterNeedle() {
    sMeterNeedle = new SMeterNeedle('s-meter-canvas');
}