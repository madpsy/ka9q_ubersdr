package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// AdminHandler handles admin-related HTTP requests
type AdminHandler struct {
	config         *Config
	configFile     string
	sessionManager *SessionManager
}

// NewAdminHandler creates a new admin handler
func NewAdminHandler(config *Config, configFile string) *AdminHandler {
	return &AdminHandler{
		config:         config,
		configFile:     configFile,
		sessionManager: NewSessionManager(),
	}
}

// IsAdminEnabled checks if admin access is enabled
func (ah *AdminHandler) IsAdminEnabled() bool {
	return ah.config.AdminPassword != ""
}

// AuthMiddleware checks if the user is authenticated
func (ah *AdminHandler) AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check if admin is enabled
		if !ah.IsAdminEnabled() {
			http.Error(w, "Admin access is not enabled", http.StatusForbidden)
			return
		}

		// Get session cookie
		cookie, err := r.Cookie("admin_session")
		if err != nil {
			http.Redirect(w, r, "/admin/login", http.StatusSeeOther)
			return
		}

		// Validate session
		if !ah.sessionManager.ValidateSession(cookie.Value) {
			http.Redirect(w, r, "/admin/login", http.StatusSeeOther)
			return
		}

		next(w, r)
	}
}

// HandleAdminLogin handles the admin login page
func (ah *AdminHandler) HandleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if !ah.IsAdminEnabled() {
		http.Error(w, "Admin access is not enabled. Set admin_password in config.yaml to enable.", http.StatusForbidden)
		return
	}

	if r.Method == "GET" {
		ah.serveLoginPage(w)
		return
	}

	if r.Method == "POST" {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Failed to parse form", http.StatusBadRequest)
			return
		}

		password := r.FormValue("password")
		if password == ah.config.AdminPassword {
			// Create session
			token := ah.sessionManager.CreateSession()

			// Set cookie
			http.SetCookie(w, &http.Cookie{
				Name:     "admin_session",
				Value:    token,
				Path:     "/",
				MaxAge:   86400, // 24 hours
				HttpOnly: true,
				SameSite: http.SameSiteStrictMode,
			})

			http.Redirect(w, r, "/admin/dashboard", http.StatusSeeOther)
			return
		}

		// Invalid password
		ah.serveLoginPage(w)
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

// HandleAdminLogout handles admin logout
func (ah *AdminHandler) HandleAdminLogout(w http.ResponseWriter, r *http.Request) {
	// Get session cookie
	cookie, err := r.Cookie("admin_session")
	if err == nil {
		// Delete session
		ah.sessionManager.DeleteSession(cookie.Value)
	}

	// Clear cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})

	http.Redirect(w, r, "/admin/login", http.StatusSeeOther)
}

// HandleAdminDashboard serves the admin dashboard
func (ah *AdminHandler) HandleAdminDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	html := ah.getAdminDashboardHTML()
	w.Write([]byte(html))
}

// HandleGetConfig returns the current configuration
func (ah *AdminHandler) HandleGetConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ah.config)
}

// HandleUpdateConfig updates the configuration
func (ah *AdminHandler) HandleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var newConfig Config
	if err := json.NewDecoder(r.Body).Decode(&newConfig); err != nil {
		http.Error(w, fmt.Sprintf("Failed to parse config: %v", err), http.StatusBadRequest)
		return
	}

	// Validate new config
	if err := newConfig.Validate(); err != nil {
		http.Error(w, fmt.Sprintf("Invalid configuration: %v", err), http.StatusBadRequest)
		return
	}

	// Save to file
	data, err := yaml.Marshal(&newConfig)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal config: %v", err), http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(ah.configFile, data, 0644); err != nil {
		http.Error(w, fmt.Sprintf("Failed to write config file: %v", err), http.StatusInternalServerError)
		return
	}

	// Update in-memory config
	*ah.config = newConfig

	log.Println("Configuration updated via admin interface - triggering application restart")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": "Configuration saved successfully. Application will restart in 2 seconds...",
	})

	// Trigger application exit after a short delay to allow response to be sent
	go func() {
		time.Sleep(2 * time.Second)
		log.Println("Exiting application for restart after config update")
		os.Exit(0)
	}()
}

// serveLoginPage serves the login HTML page
func (ah *AdminHandler) serveLoginPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html")
	html := `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Login - WSPR MQTT Aggregator</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .login-container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 400px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 24px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 600;
        }
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #667eea;
        }
        button {
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
        }
        button:active {
            transform: translateY(0);
        }
        .back-link {
            text-align: center;
            margin-top: 20px;
        }
        .back-link a {
            color: #667eea;
            text-decoration: none;
            font-size: 14px;
        }
        .back-link a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <h1>🔐 Admin Login</h1>
        <p class="subtitle">WSPR MQTT Aggregator</p>
        <form method="POST" action="/admin/login">
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required autofocus>
            </div>
            <button type="submit">Login</button>
        </form>
        <div class="back-link">
            <a href="/">← Back to Dashboard</a>
        </div>
    </div>
</body>
</html>`
	w.Write([]byte(html))
}

// getAdminDashboardHTML returns the admin dashboard HTML
func (ah *AdminHandler) getAdminDashboardHTML() string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard - WSPR MQTT Aggregator</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        h1 {
            font-size: 2em;
        }
        .logout-btn {
            padding: 10px 20px;
            background: rgba(255,255,255,0.2);
            color: white;
            border: 2px solid white;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            text-decoration: none;
            transition: all 0.2s;
        }
        .logout-btn:hover {
            background: rgba(255,255,255,0.3);
        }
        .container {
            background: #1e293b;
            padding: 30px;
            border-radius: 12px;
            border: 1px solid #334155;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        .section-title {
            font-size: 1.5em;
            margin-bottom: 20px;
            color: #60a5fa;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #94a3b8;
            font-weight: 600;
        }
        input[type="text"],
        input[type="number"],
        input[type="password"] {
            width: 100%;
            padding: 12px;
            background: #0f172a;
            border: 2px solid #334155;
            border-radius: 8px;
            color: #e2e8f0;
            font-size: 14px;
        }
        input:focus {
            outline: none;
            border-color: #60a5fa;
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        input[type="checkbox"] {
            width: 20px;
            height: 20px;
            cursor: pointer;
        }
        .btn {
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
            margin-right: 10px;
        }
        .btn:hover {
            transform: translateY(-2px);
        }
        .btn-secondary {
            background: #334155;
        }
        .btn-danger {
            background: #ef4444;
        }
        .instance-list {
            margin-top: 20px;
        }
        .instance-item {
            background: #0f172a;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border: 1px solid #334155;
        }
        .instance-info {
            flex: 1;
        }
        .instance-name {
            font-weight: 600;
            color: #60a5fa;
            margin-bottom: 5px;
        }
        .instance-prefix {
            color: #94a3b8;
            font-size: 0.9em;
        }
        .message {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: none;
        }
        .message.success {
            background: #10b981;
            color: white;
        }
        .message.error {
            background: #ef4444;
            color: white;
        }
        .grid-2col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
        }
        @media (max-width: 768px) {
            .grid-2col {
                grid-template-columns: 1fr;
            }
        }
        .back-link {
            text-align: center;
            margin-top: 20px;
        }
        .back-link a {
            color: #60a5fa;
            text-decoration: none;
        }
        .back-link a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1>⚙️ Admin Dashboard</h1>
            <div style="opacity: 0.9; margin-top: 5px;">WSPR MQTT Aggregator Configuration</div>
        </div>
        <a href="/admin/logout" class="logout-btn">Logout</a>
    </div>

    <div id="message" class="message"></div>

    <div class="container">
        <h2 class="section-title">Receiver Configuration</h2>
        <div class="grid-2col">
            <div class="form-group">
                <label for="callsign">Callsign</label>
                <input type="text" id="callsign" placeholder="e.g., W1ABC">
            </div>
            <div class="form-group">
                <label for="locator">Locator</label>
                <input type="text" id="locator" placeholder="e.g., FN42">
            </div>
        </div>
    </div>

    <div class="container">
        <h2 class="section-title">MQTT Configuration</h2>
        <div class="form-group">
            <label for="broker">Broker URL</label>
            <input type="text" id="broker" placeholder="e.g., tcp://localhost:1883">
        </div>
        <div class="grid-2col">
            <div class="form-group">
                <label for="username">Username (optional)</label>
                <input type="text" id="username">
            </div>
            <div class="form-group">
                <label for="password">Password (optional)</label>
                <input type="password" id="password">
            </div>
        </div>
        <div class="form-group">
            <label for="qos">QoS Level</label>
            <input type="number" id="qos" min="0" max="2" value="0">
        </div>
    </div>

    <div class="container">
        <h2 class="section-title">MQTT Instances</h2>
        <div id="instanceList" class="instance-list"></div>
        <button class="btn" onclick="addInstance()">+ Add Instance</button>
    </div>

    <div class="container">
        <h2 class="section-title">Other Settings</h2>
        <div class="grid-2col">
            <div class="form-group">
                <label for="webPort">Web Port</label>
                <input type="number" id="webPort" value="9009">
            </div>
            <div class="form-group">
                <label for="persistenceFile">Persistence File</label>
                <input type="text" id="persistenceFile" value="wsprnet_stats.json">
            </div>
        </div>
        <div class="form-group checkbox-group">
            <input type="checkbox" id="dryRun">
            <label for="dryRun" style="margin-bottom: 0;">Dry Run Mode (don't send to WSPRNet)</label>
        </div>
        <div class="form-group">
            <label for="adminPassword">Admin Password</label>
            <input type="password" id="adminPassword" placeholder="Leave empty to disable admin access">
        </div>
    </div>

    <div class="container">
        <button class="btn" onclick="saveConfig()">💾 Save Configuration</button>
        <button class="btn btn-secondary" onclick="loadConfig()">🔄 Reload</button>
    </div>

    <div class="back-link">
        <a href="/">← Back to Main Dashboard</a>
    </div>

    <script>
        let config = {};

        // Load configuration on page load
        window.addEventListener('DOMContentLoaded', loadConfig);

        async function loadConfig() {
            try {
                const response = await fetch('/admin/api/config');
                config = await response.json();
                
                // Populate form fields
                document.getElementById('callsign').value = config.receiver.callsign || '';
                document.getElementById('locator').value = config.receiver.locator || '';
                document.getElementById('broker').value = config.mqtt.broker || '';
                document.getElementById('username').value = config.mqtt.username || '';
                document.getElementById('password').value = config.mqtt.password || '';
                document.getElementById('qos').value = config.mqtt.qos || 0;
                document.getElementById('webPort').value = config.web_port || 9009;
                document.getElementById('persistenceFile').value = config.persistence_file || 'wsprnet_stats.json';
                document.getElementById('dryRun').checked = config.dry_run || false;
                document.getElementById('adminPassword').value = config.admin_password || '';
                
                // Render instances
                renderInstances();
            } catch (error) {
                showMessage('Failed to load configuration: ' + error.message, 'error');
            }
        }

        function renderInstances() {
            const container = document.getElementById('instanceList');
            container.innerHTML = '';
            
            if (!config.mqtt.instances || config.mqtt.instances.length === 0) {
                container.innerHTML = '<p style="color: #94a3b8;">No instances configured</p>';
                return;
            }
            
            config.mqtt.instances.forEach((instance, index) => {
                const div = document.createElement('div');
                div.className = 'instance-item';
                div.innerHTML = ` + "`" + `
                    <div class="instance-info">
                        <div class="instance-name">${instance.name}</div>
                        <div class="instance-prefix">Topic Prefix: ${instance.topic_prefix}</div>
                    </div>
                    <div>
                        <button class="btn btn-secondary" onclick="editInstance(${index})">Edit</button>
                        <button class="btn btn-danger" onclick="deleteInstance(${index})">Delete</button>
                    </div>
                ` + "`" + `;
                container.appendChild(div);
            });
        }

        function addInstance() {
            const name = prompt('Instance name:');
            if (!name) return;
            
            const topicPrefix = prompt('Topic prefix:');
            if (!topicPrefix) return;
            
            if (!config.mqtt.instances) {
                config.mqtt.instances = [];
            }
            
            config.mqtt.instances.push({
                name: name,
                topic_prefix: topicPrefix
            });
            
            renderInstances();
        }

        function editInstance(index) {
            const instance = config.mqtt.instances[index];
            
            const name = prompt('Instance name:', instance.name);
            if (name === null) return;
            
            const topicPrefix = prompt('Topic prefix:', instance.topic_prefix);
            if (topicPrefix === null) return;
            
            config.mqtt.instances[index] = {
                name: name,
                topic_prefix: topicPrefix
            };
            
            renderInstances();
        }

        function deleteInstance(index) {
            if (!confirm('Are you sure you want to delete this instance?')) return;
            
            config.mqtt.instances.splice(index, 1);
            renderInstances();
        }

        async function saveConfig() {
            // Show confirmation dialog
            if (!confirm('⚠️ Warning: Saving the configuration will restart the application.\n\nDo you want to continue?')) {
                return;
            }

            // Build config object from form
            const newConfig = {
                receiver: {
                    callsign: document.getElementById('callsign').value,
                    locator: document.getElementById('locator').value
                },
                mqtt: {
                    broker: document.getElementById('broker').value,
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value,
                    qos: parseInt(document.getElementById('qos').value),
                    instances: config.mqtt.instances || []
                },
                web_port: parseInt(document.getElementById('webPort').value),
                dry_run: document.getElementById('dryRun').checked,
                persistence_file: document.getElementById('persistenceFile').value,
                admin_password: document.getElementById('adminPassword').value
            };
            
            try {
                const response = await fetch('/admin/api/config', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(newConfig)
                });
                
                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(error);
                }
                
                const result = await response.json();
                
                // Show countdown overlay
                showRestartCountdown();
            } catch (error) {
                showMessage('Failed to save configuration: ' + error.message, 'error');
            }
        }

        function showRestartCountdown() {
            // Create overlay
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.9); display: flex; align-items: center; justify-content: center; z-index: 9999; animation: fadeIn 0.3s;';
            
            const content = document.createElement('div');
            content.style.cssText = 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 60px; border-radius: 16px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5);';
            
            const icon = document.createElement('div');
            icon.style.cssText = 'font-size: 64px; margin-bottom: 20px; animation: pulse 1s infinite;';
            icon.textContent = '🔄';
            
            const title = document.createElement('h2');
            title.style.cssText = 'font-size: 28px; margin-bottom: 10px; color: white;';
            title.textContent = 'Configuration Saved';
            
            const message = document.createElement('p');
            message.style.cssText = 'font-size: 18px; margin-bottom: 20px; color: rgba(255,255,255,0.9);';
            message.textContent = 'Application restarting in';
            
            const countdown = document.createElement('div');
            countdown.style.cssText = 'font-size: 72px; font-weight: bold; color: white; margin: 20px 0; font-family: monospace;';
            countdown.textContent = '5';
            
            content.appendChild(icon);
            content.appendChild(title);
            content.appendChild(message);
            content.appendChild(countdown);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
            
            // Add animations
            const style = document.createElement('style');
            style.textContent = '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }';
            document.head.appendChild(style);
            
            // Countdown
            let count = 5;
            const interval = setInterval(() => {
                count--;
                countdown.textContent = count;
                
                if (count === 0) {
                    clearInterval(interval);
                    countdown.textContent = '0';
                    message.textContent = 'Restarting now...';
                    
                    // Refresh page after a short delay
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                }
            }, 1000);
        }

        function showMessage(text, type) {
            const messageDiv = document.getElementById('message');
            messageDiv.textContent = text;
            messageDiv.className = 'message ' + type;
            messageDiv.style.display = 'block';
            
            setTimeout(() => {
                messageDiv.style.display = 'none';
            }, 5000);
        }
    </script>
</body>
</html>`
}
