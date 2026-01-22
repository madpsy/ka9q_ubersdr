#!/usr/bin/env python3
"""
Web-based TDOA Processor for UberSDR IQ Recordings

A Flask web application for processing synchronized IQ recordings
and visualizing TDOA geolocation results.
"""

from flask import Flask, render_template, request, jsonify, send_from_directory
import os
import json
import numpy as np
from tdoa_processor import TDOAProcessor, scan_directory
from datetime import datetime

app = Flask(__name__)

# Configuration
RECORDINGS_DIR = os.environ.get('RECORDINGS_DIR', '.')
app.config['RECORDINGS_DIR'] = RECORDINGS_DIR


@app.route('/')
def index():
    """Main page"""
    return render_template('index.html')


@app.route('/api/sessions')
def get_sessions():
    """Get available recording sessions"""
    try:
        sessions = scan_directory(app.config['RECORDINGS_DIR'])
        
        # Format sessions for JSON response
        session_list = []
        for timestamp, wav_files in sorted(sessions.items(), reverse=True):
            # Parse timestamp
            try:
                dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                time_str = dt.strftime('%Y-%m-%d %H:%M:%S UTC')
            except:
                time_str = timestamp
            
            # Extract frequency from first file
            first_file = os.path.basename(wav_files[0])
            parts = first_file.split('_')
            frequency = parts[1] if len(parts) >= 2 else "0"
            freq_mhz = float(frequency) / 1e6 if frequency.isdigit() else 0
            
            # Get hostnames
            hostnames = []
            for wav_file in wav_files:
                basename = os.path.basename(wav_file)
                hostname = basename.split('_')[0]
                hostnames.append(hostname)
            
            session_list.append({
                'timestamp': timestamp,
                'time_str': time_str,
                'frequency_hz': int(frequency) if frequency.isdigit() else 0,
                'frequency_mhz': freq_mhz,
                'receiver_count': len(wav_files),
                'receivers': hostnames,
                'files': [os.path.basename(f) for f in wav_files]
            })
        
        return jsonify({
            'success': True,
            'sessions': session_list
        })
    
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/process', methods=['POST'])
def process_tdoa():
    """Process TDOA for selected session"""
    try:
        data = request.json
        timestamp = data.get('timestamp')
        offset = float(data.get('offset', 0))
        bandwidth = float(data.get('bandwidth', 24000))
        no_position = data.get('no_position', False)
        
        if not timestamp:
            return jsonify({
                'success': False,
                'error': 'No timestamp provided'
            }), 400
        
        # Get session files
        sessions = scan_directory(app.config['RECORDINGS_DIR'])
        if timestamp not in sessions:
            return jsonify({
                'success': False,
                'error': 'Session not found'
            }), 404
        
        wav_files = sessions[timestamp]
        
        # Create processor
        processor = TDOAProcessor()
        
        # Load recordings
        receivers_loaded = []
        for wav_file in wav_files:
            json_file = wav_file.replace('.wav', '.json')
            
            if not os.path.exists(json_file):
                continue
            
            try:
                receiver = processor.load_recording(wav_file, json_file)
                receivers_loaded.append({
                    'hostname': receiver.hostname,
                    'callsign': receiver.callsign,
                    'location': receiver.location,
                    'latitude': receiver.latitude,
                    'longitude': receiver.longitude,
                    'altitude': receiver.altitude,
                    'samples': len(receiver.iq_data)
                })
            except Exception as e:
                print(f"Error loading {wav_file}: {e}")
                continue
        
        if len(processor.receivers) < 2:
            return jsonify({
                'success': False,
                'error': 'Need at least 2 valid recordings'
            }), 400
        
        # Get spectrum data before processing
        # Always show at least 5 kHz span for useful visualization
        spectrum_span = max(5000, bandwidth * 3)
        spectrum_data = processor.get_spectrum_data(offset, spectrum_span)
        
        # Calculate TDOA (don't show console spectrum in web mode)
        processor.calculate_tdoa(offset, bandwidth, show_spectrum=False)
        
        # Format TDOA results (convert numpy types to Python types for JSON)
        tdoa_results = []
        for result in processor.tdoa_results:
            tdoa_results.append({
                'receiver1': str(result.receiver1),
                'receiver2': str(result.receiver2),
                'tdoa_seconds': float(result.tdoa_seconds),
                'tdoa_microseconds': float(result.tdoa_seconds * 1e6),
                'tdoa_samples': int(result.tdoa_samples),
                'correlation_peak': float(result.correlation_peak),
                'confidence': float(result.confidence),
                'distance_diff_km': float(result.tdoa_seconds * processor.SPEED_OF_LIGHT / 1000),
                'snr_db_rx1': float(result.snr_db_rx1),
                'snr_db_rx2': float(result.snr_db_rx2)
            })
        
        # Estimate position (only if we have 3+ receivers for proper trilateration)
        position = None
        position_error = None
        if not no_position and len(processor.receivers) >= 3:
            pos_result = processor.estimate_position()
            if pos_result:
                est_lat, est_lon, uncertainty_m = pos_result
                # Validate coordinates are reasonable
                if -90 <= est_lat <= 90 and -180 <= est_lon <= 180:
                    position = {
                        'latitude': float(est_lat),
                        'longitude': float(est_lon),
                        'uncertainty_km': float(uncertainty_m / 1000)
                    }
                else:
                    position_error = f"Position estimation produced invalid coordinates: {est_lat:.2f}°, {est_lon:.2f}°. This usually indicates poor receiver geometry, weak signal, or timing issues."
                    print(f"Warning: Invalid position estimate: {est_lat}, {est_lon}")
            else:
                position_error = "Position estimation failed to converge. Try adjusting frequency offset or bandwidth."
        elif not no_position and len(processor.receivers) < 3:
            position_error = f"Need at least 3 receivers for position estimation (currently have {len(processor.receivers)})"
        
        # Get center frequency from first file
        first_file = os.path.basename(wav_files[0])
        parts = first_file.split('_')
        frequency = parts[1] if len(parts) >= 2 else "0"
        center_freq_hz = int(frequency) if frequency.isdigit() else 0
        
        return jsonify({
            'success': True,
            'receivers': receivers_loaded,
            'spectrum_data': spectrum_data,
            'tdoa_results': tdoa_results,
            'position': position,
            'position_error': position_error,
            'processing_params': {
                'offset_hz': float(offset),
                'bandwidth_hz': float(bandwidth),
                'sample_rate': int(processor.sample_rate),
                'center_freq_hz': int(center_freq_hz)
            }
        })
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/static/<path:path>')
def send_static(path):
    """Serve static files"""
    return send_from_directory('static', path)


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='TDOA Processor Web Interface')
    parser.add_argument('--dir', default='.', help='Directory containing recordings')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--port', type=int, default=5000, help='Port to bind to')
    parser.add_argument('--debug', action='store_true', help='Enable debug mode')
    
    args = parser.parse_args()
    
    app.config['RECORDINGS_DIR'] = os.path.abspath(args.dir)
    
    print(f"Starting TDOA Processor Web Interface")
    print(f"Recordings directory: {app.config['RECORDINGS_DIR']}")
    print(f"Server: http://{args.host}:{args.port}")
    
    app.run(host=args.host, port=args.port, debug=args.debug)
