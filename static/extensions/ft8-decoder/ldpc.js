// LDPC Decoder for FT8
// JavaScript port of the C implementation
// Implements sum-product algorithm (belief propagation)

// Fast approximations for tanh and atanh
function fast_tanh(x) {
    if (x < -4.97) return -1.0;
    if (x > 4.97) return 1.0;
    
    const x2 = x * x;
    const a = x * (945.0 + x2 * (105.0 + x2));
    const b = 945.0 + x2 * (420.0 + x2 * 15.0);
    return a / b;
}

function fast_atanh(x) {
    const x2 = x * x;
    const a = x * (945.0 + x2 * (-735.0 + x2 * 64.0));
    const b = 945.0 + x2 * (-1050.0 + x2 * 225.0);
    return a / b;
}

// Check if codeword passes LDPC parity checks
// Returns number of parity errors (0 = success)
function ldpc_check(codeword, FTX_LDPC_M, kFTX_LDPC_Num_rows, kFTX_LDPC_Nm) {
    let errors = 0;
    
    for (let m = 0; m < FTX_LDPC_M; m++) {
        let x = 0;
        for (let i = 0; i < kFTX_LDPC_Num_rows[m]; i++) {
            x ^= codeword[kFTX_LDPC_Nm[m][i] - 1];
        }
        if (x !== 0) {
            errors++;
        }
    }
    
    return errors;
}

// LDPC decoder using sum-product algorithm
// codeword: Float32Array of 174 log-likelihood ratios
// max_iters: maximum iterations to try
// Returns: { plain: Uint8Array(174), errors: number }
function ldpc_decode(codeword, max_iters, FTX_LDPC_M, FTX_LDPC_N, kFTX_LDPC_Num_rows, kFTX_LDPC_Nm, kFTX_LDPC_Mn) {
    // Initialize message arrays
    const m = Array(FTX_LDPC_M);
    const e = Array(FTX_LDPC_M);
    
    for (let j = 0; j < FTX_LDPC_M; j++) {
        m[j] = new Float32Array(FTX_LDPC_N);
        e[j] = new Float32Array(FTX_LDPC_N);
        
        for (let i = 0; i < FTX_LDPC_N; i++) {
            m[j][i] = codeword[i];
            e[j][i] = 0.0;
        }
    }
    
    const plain = new Uint8Array(FTX_LDPC_N);
    let min_errors = FTX_LDPC_M;
    
    // Iterative decoding
    for (let iter = 0; iter < max_iters; iter++) {
        // Check node update
        for (let j = 0; j < FTX_LDPC_M; j++) {
            for (let ii1 = 0; ii1 < kFTX_LDPC_Num_rows[j]; ii1++) {
                const i1 = kFTX_LDPC_Nm[j][ii1] - 1;
                let a = 1.0;
                
                for (let ii2 = 0; ii2 < kFTX_LDPC_Num_rows[j]; ii2++) {
                    const i2 = kFTX_LDPC_Nm[j][ii2] - 1;
                    if (i2 !== i1) {
                        a *= fast_tanh(-m[j][i2] / 2.0);
                    }
                }
                
                e[j][i1] = -2.0 * fast_atanh(a);
            }
        }
        
        // Variable node update - make hard decision
        for (let i = 0; i < FTX_LDPC_N; i++) {
            let l = codeword[i];
            for (let j = 0; j < 3; j++) {
                const check_idx = kFTX_LDPC_Mn[i][j] - 1;
                if (check_idx >= 0 && check_idx < FTX_LDPC_M) {
                    l += e[check_idx][i];
                }
            }
            plain[i] = (l > 0) ? 1 : 0;
        }
        
        // Check for valid codeword
        const errors = ldpc_check(plain, FTX_LDPC_M, kFTX_LDPC_Num_rows, kFTX_LDPC_Nm);
        
        if (errors < min_errors) {
            min_errors = errors;
            
            if (errors === 0) {
                break; // Perfect decode
            }
        }
        
        // Update messages from variable nodes to check nodes
        for (let i = 0; i < FTX_LDPC_N; i++) {
            for (let ji1 = 0; ji1 < 3; ji1++) {
                const j1 = kFTX_LDPC_Mn[i][ji1] - 1;
                if (j1 < 0 || j1 >= FTX_LDPC_M) continue;
                
                let l = codeword[i];
                
                for (let ji2 = 0; ji2 < 3; ji2++) {
                    if (ji1 !== ji2) {
                        const j2 = kFTX_LDPC_Mn[i][ji2] - 1;
                        if (j2 >= 0 && j2 < FTX_LDPC_M) {
                            l += e[j2][i];
                        }
                    }
                }
                
                m[j1][i] = l;
            }
        }
    }
    
    return { plain, errors: min_errors };
}

// Belief propagation decoder (alternative algorithm)
function bp_decode(codeword, max_iters, FTX_LDPC_M, FTX_LDPC_N, kFTX_LDPC_Num_rows, kFTX_LDPC_Nm, kFTX_LDPC_Mn) {
    const tov = Array(FTX_LDPC_N);
    const toc = Array(FTX_LDPC_M);
    
    // Initialize
    for (let n = 0; n < FTX_LDPC_N; n++) {
        tov[n] = new Float32Array(3);
    }
    
    for (let m = 0; m < FTX_LDPC_M; m++) {
        toc[m] = new Float32Array(7);
    }
    
    const plain = new Uint8Array(FTX_LDPC_N);
    let min_errors = FTX_LDPC_M;
    
    for (let iter = 0; iter < max_iters; iter++) {
        // Hard decision
        let plain_sum = 0;
        for (let n = 0; n < FTX_LDPC_N; n++) {
            plain[n] = ((codeword[n] + tov[n][0] + tov[n][1] + tov[n][2]) > 0) ? 1 : 0;
            plain_sum += plain[n];
        }
        
        if (plain_sum === 0) {
            break; // Converged to all-zeros (prohibited)
        }
        
        // Check parity
        const errors = ldpc_check(plain, FTX_LDPC_M, kFTX_LDPC_Num_rows, kFTX_LDPC_Nm);
        
        if (errors < min_errors) {
            min_errors = errors;
            
            if (errors === 0) {
                break;
            }
        }
        
        // Bit to check messages
        for (let m = 0; m < FTX_LDPC_M; m++) {
            for (let n_idx = 0; n_idx < kFTX_LDPC_Num_rows[m]; n_idx++) {
                const n = kFTX_LDPC_Nm[m][n_idx] - 1;
                let Tnm = codeword[n];
                
                for (let m_idx = 0; m_idx < 3; m_idx++) {
                    if ((kFTX_LDPC_Mn[n][m_idx] - 1) !== m) {
                        Tnm += tov[n][m_idx];
                    }
                }
                
                toc[m][n_idx] = fast_tanh(-Tnm / 2);
            }
        }
        
        // Check to bit messages
        for (let n = 0; n < FTX_LDPC_N; n++) {
            for (let m_idx = 0; m_idx < 3; m_idx++) {
                const m = kFTX_LDPC_Mn[n][m_idx] - 1;
                let Tmn = 1.0;
                
                for (let n_idx = 0; n_idx < kFTX_LDPC_Num_rows[m]; n_idx++) {
                    if ((kFTX_LDPC_Nm[m][n_idx] - 1) !== n) {
                        Tmn *= toc[m][n_idx];
                    }
                }
                
                tov[n][m_idx] = -2 * fast_atanh(Tmn);
            }
        }
    }
    
    return { plain, errors: min_errors };
}

// Export functions to global scope for browser use
window.ldpc_decode = ldpc_decode;
window.bp_decode = bp_decode;
window.ldpc_check = ldpc_check;
window.fast_tanh = fast_tanh;
window.fast_atanh = fast_atanh;

// Also support module exports for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ldpc_decode,
        bp_decode,
        ldpc_check,
        fast_tanh,
        fast_atanh
    };
}