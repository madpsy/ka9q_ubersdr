#!/bin/bash

# Exit on error
set -e

# Parse command line arguments
MAX_RATE=0
for arg in "$@"; do
    case $arg in
        --max-rate)
            MAX_RATE=1
            shift
            ;;
    esac
done

echo "=== UberSDR FFTW Wisdom Generator ==="
echo

# Check if tmux is installed
if ! command -v tmux &> /dev/null; then
    echo "Error: tmux is not installed. Please install it first:"
    echo "  sudo apt install -y tmux"
    exit 1
fi

# Check if fftwf-wisdom is installed (check under sudo context)
if ! sudo which fftwf-wisdom &> /dev/null; then
    echo "Error: fftwf-wisdom is not installed. Please install it first:"
    echo "  sudo apt install -y libfftw3-bin"
    exit 1
fi

WISDOM_FILE="/var/lib/docker/volumes/ubersdr_radiod-data/_data/wisdom"
SESSION_NAME="generate-wisdom"

# Check if session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Error: tmux session '$SESSION_NAME' already exists."
    echo "Attach to it with: tmux attach -t $SESSION_NAME"
    echo "Or kill it first with: tmux kill-session -t $SESSION_NAME"
    exit 1
fi

# Check if wisdom file already exists and ask user if they want to continue
if sudo test -f "$WISDOM_FILE"; then
    echo "WARNING: A wisdom file already exists at:"
    echo "  $WISDOM_FILE"
    echo
    read -p "Do you want to continue and regenerate it? (y/N): " -n 1 -r
    echo
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Wisdom generation cancelled."
        exit 0
    fi
    
    # Backup existing wisdom file
    BACKUP_FILE="${WISDOM_FILE}.backup"
    echo "Moving existing wisdom file to ${BACKUP_FILE}..."
    sudo mv "$WISDOM_FILE" "$BACKUP_FILE"
    echo "Backup created at ${BACKUP_FILE}"
    echo
fi

FFT_SIZES="rof1620000 rof810000 cob162000 cob81000 cob40500 cob32400 \
    cob16200 cob9600 cob8100 cob6930 cob4860 cob4800 cob3240 cob3200 cob1920 cob1620 cob1600 \
    cob1200 cob960 cob810 cob800 cob600 cob480 cob405 cob400 cob320 cob300 cob205 cob200 cob160 cob85 cob45 cob15"

# Ask user about RX888 MKII @ 129.6 MSPS support only if --max-rate is specified
if [ $MAX_RATE -eq 1 ]; then
    echo
    echo "Do you want to generate wisdom for RX888 MKII @ 129.6 MSPS?"
    echo
    echo "WARNING: This adds rof3240000 to the generation and may take SEVERAL HOURS."
    echo "         129.6 MSPS is NOT required for most users."
    echo
    read -p "Generate for 129.6 MSPS? (y/N): " -n 1 -r
    echo
    echo

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Including 129.6 MSPS support (rof3240000)..."
        FFT_SIZES="rof3240000 $FFT_SIZES"
    else
        echo "Skipping 129.6 MSPS support..."
    fi
fi

echo
echo "Creating tmux session '$SESSION_NAME' and starting FFTW Wisdom generation..."
echo "This will take some time. Be patient!"
echo
echo "To attach to the session and monitor progress:"
echo "  tmux attach -t $SESSION_NAME"
echo
echo "To detach from the session (without stopping it):"
echo "  Press Ctrl+B, then D"
echo

# Create tmux session and run the wisdom generation command
tmux new-session -d -s "$SESSION_NAME" -n 'Generate Wisdom' "sudo fftwf-wisdom -v -T 1 -o '$WISDOM_FILE' \
    $FFT_SIZES && \
    echo && \
    echo '=== FFTW Wisdom generation completed successfully! ===' && \
    echo 'Press Enter to close this session...' && \
    read"

echo "Tmux session '$SESSION_NAME' created and wisdom generation started!"
echo
echo "Attaching to session now..."
sleep 1
tmux attach -t "$SESSION_NAME"
