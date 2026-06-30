package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// TelegramChannel implements NotificationChannel for the Telegram Bot API.
// No external dependencies — the Telegram Bot API is plain HTTPS JSON.
type TelegramChannel struct {
	name    string
	cfg     NotificationChannelConfig
	client  *http.Client
	apiBase string
}

// NewTelegramChannel creates a new TelegramChannel.
func NewTelegramChannel(name string, cfg NotificationChannelConfig) *TelegramChannel {
	return &TelegramChannel{
		name:    name,
		cfg:     cfg,
		client:  &http.Client{Timeout: 15 * time.Second},
		apiBase: fmt.Sprintf("https://api.telegram.org/bot%s", cfg.BotToken),
	}
}

func (t *TelegramChannel) Name() string { return t.name }
func (t *TelegramChannel) Type() string { return "telegram" }

// telegramSendMessageRequest is the JSON body for the sendMessage API call.
type telegramSendMessageRequest struct {
	ChatID                string `json:"chat_id"`
	Text                  string `json:"text"`
	ParseMode             string `json:"parse_mode,omitempty"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview"`
}

// telegramAPIResponse is the minimal response envelope from the Telegram API.
type telegramAPIResponse struct {
	OK          bool            `json:"ok"`
	Description string          `json:"description,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
}

// Send delivers message to the configured Telegram chat.
// It retries once on a transient HTTP error (5xx) with a 2-second delay.
func (t *TelegramChannel) Send(message string) error {
	return t.sendWithRetry(message, 2)
}

func (t *TelegramChannel) sendWithRetry(message string, attemptsLeft int) error {
	parseMode := t.cfg.ParseMode
	if parseMode == "" {
		parseMode = "HTML"
	}

	payload := telegramSendMessageRequest{
		ChatID:                t.cfg.ChatID,
		Text:                  message,
		ParseMode:             parseMode,
		DisableWebPagePreview: true,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("telegram: marshal error: %w", err)
	}

	url := t.apiBase + "/sendMessage"
	resp, err := t.client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		if attemptsLeft > 1 {
			log.Printf("[Telegram:%s] HTTP error (retrying): %v", t.name, err)
			time.Sleep(2 * time.Second)
			return t.sendWithRetry(message, attemptsLeft-1)
		}
		return fmt.Errorf("telegram: HTTP error: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	// Retry on 5xx
	if resp.StatusCode >= 500 && attemptsLeft > 1 {
		log.Printf("[Telegram:%s] Server error %d (retrying)", t.name, resp.StatusCode)
		time.Sleep(2 * time.Second)
		return t.sendWithRetry(message, attemptsLeft-1)
	}

	var apiResp telegramAPIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return fmt.Errorf("telegram: unexpected response (status %d): %s", resp.StatusCode, string(respBody))
	}

	if !apiResp.OK {
		return fmt.Errorf("telegram API error: %s", apiResp.Description)
	}

	return nil
}
