# Claude Streaming API Wrapper (Node.js)

A secure, production-ready Node.js backend that wraps the Claude Messages API with real-time streaming, input validation, and security controls.  
Built to serve as infrastructure for AI-powered applications rather than a prompt-level demo.

---

## Overview

This project provides a clean Express.js server that exposes a streaming chat endpoint backed by the Claude Messages API. It focuses on:

- real-time streamed responses
- request validation and normalization
- privacy-aware output handling
- production-grade middleware and logging

The wrapper is designed to be extended and embedded into larger AI-driven systems.

---

## Features

- **Streaming responses**
  - Streams text output token-by-token to clients
- **Secure API design**
  - Rate limiting (per-IP)
  - Optional origin locking via environment configuration
  - Helmet security headers
- **Input validation**
  - Strict message schema enforcement
  - Model allow-listing
  - Parameter clamping (temperature, token limits)
- **Privacy safeguards**
  - Prevents provider and model name disclosure in outputs
  - Sanitized upstream error handling
- **Observability**
  - Request ID injection and structured logging
- **Abort handling**
  - Cancels upstream requests when the client disconnects

---

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Security:** Helmet, express-rate-limit
- **AI Provider:** Claude (Messages API, streaming)
- **Config:** dotenv

---

## API Endpoints

### Health Check
```http
GET /api/health
