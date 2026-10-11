//! A bounded JSON scanner that retains value byte spans instead of converting numbers.
//!
//! Rewrites must reject duplicate decoded keys in every object. Observers may choose
//! to treat any scanner failure as unavailable without exposing request contents.

use std::collections::HashSet;
use thiserror::Error;

const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum JsonScanError {
    #[error("request body is not valid supported JSON")]
    InvalidJson,
    #[error("request JSON root must be an object")]
    RootNotObject,
    #[error("request JSON contains duplicate object keys")]
    DuplicateKey,
}

#[derive(Debug, Clone)]
pub struct JsonMember {
    pub key: String,
    pub key_start: usize,
    pub value_start: usize,
    pub value_end: usize,
}

#[derive(Debug, Clone)]
pub struct JsonObject {
    pub members: Vec<JsonMember>,
    pub close: usize,
}

impl JsonObject {
    pub fn member(&self, name: &str) -> Option<&JsonMember> {
        self.members.iter().find(|member| member.key == name)
    }
}

/// Validate one complete JSON object, including all nested objects and arrays.
/// Numeric tokens remain untouched, including integers larger than u64 and
/// exponents beyond floating point limits. Duplicate keys use decoded equality.
pub fn scan_object(body: &[u8]) -> Result<JsonObject, JsonScanError> {
    std::str::from_utf8(body).map_err(|_| JsonScanError::InvalidJson)?;
    let mut parser = Parser { body, position: 0 };
    parser.whitespace();
    let result = if parser.peek() == Some(b'{') {
        Some(parser.object(1, true)?)
    } else {
        parser.value(0)?;
        None
    };
    parser.whitespace();
    if parser.position != body.len() {
        return Err(JsonScanError::InvalidJson);
    }
    result.ok_or(JsonScanError::RootNotObject)
}

/// Validate a complete array and retain each element span for bounded wildcard field edits.
pub fn scan_array(body: &[u8]) -> Result<Vec<(usize, usize)>, JsonScanError> {
    std::str::from_utf8(body).map_err(|_| JsonScanError::InvalidJson)?;
    let mut parser = Parser { body, position: 0 };
    parser.whitespace();
    parser.require(b'[')?;
    parser.whitespace();
    let mut spans = Vec::new();
    if parser.peek() == Some(b']') {
        parser.position += 1;
    } else {
        loop {
            let start = parser.position;
            parser.value(1)?;
            spans.push((start, parser.position));
            parser.whitespace();
            if parser.peek() == Some(b']') {
                parser.position += 1;
                break;
            }
            parser.require(b',')?;
            parser.whitespace();
        }
    }
    parser.whitespace();
    if parser.position != body.len() {
        return Err(JsonScanError::InvalidJson);
    }
    Ok(spans)
}
struct Parser<'a> {
    body: &'a [u8],
    position: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.body.get(self.position).copied()
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.position += 1;
        }
    }

    fn require(&mut self, expected: u8) -> Result<(), JsonScanError> {
        if self.peek() != Some(expected) {
            return Err(JsonScanError::InvalidJson);
        }
        self.position += 1;
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<(), JsonScanError> {
        if depth > MAX_DEPTH {
            return Err(JsonScanError::InvalidJson);
        }
        match self.peek() {
            Some(b'{') => {
                self.object(depth + 1, false)?;
            }
            Some(b'[') => self.array(depth + 1)?,
            Some(b'"') => {
                self.string()?;
            }
            Some(b't') => self.literal(b"true")?,
            Some(b'f') => self.literal(b"false")?,
            Some(b'n') => self.literal(b"null")?,
            Some(b'-' | b'0'..=b'9') => self.number()?,
            _ => return Err(JsonScanError::InvalidJson),
        }
        Ok(())
    }

    fn object(&mut self, depth: usize, capture: bool) -> Result<JsonObject, JsonScanError> {
        if depth > MAX_DEPTH {
            return Err(JsonScanError::InvalidJson);
        }
        self.require(b'{')?;
        self.whitespace();
        let mut keys = HashSet::new();
        let mut members = Vec::new();
        if self.peek() == Some(b'}') {
            let close = self.position;
            self.position += 1;
            return Ok(JsonObject { members, close });
        }
        loop {
            let key_start = self.position;
            let key = self.string()?;
            if !keys.insert(key.clone()) {
                return Err(JsonScanError::DuplicateKey);
            }
            self.whitespace();
            self.require(b':')?;
            self.whitespace();
            let value_start = self.position;
            self.value(depth)?;
            let value_end = self.position;
            if capture {
                members.push(JsonMember {
                    key,
                    key_start,
                    value_start,
                    value_end,
                });
            }
            self.whitespace();
            match self.peek() {
                Some(b'}') => {
                    let close = self.position;
                    self.position += 1;
                    return Ok(JsonObject { members, close });
                }
                Some(b',') => {
                    self.position += 1;
                    self.whitespace();
                    // A trailing comma is rejected by the next key parser.
                }
                _ => return Err(JsonScanError::InvalidJson),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<(), JsonScanError> {
        if depth > MAX_DEPTH {
            return Err(JsonScanError::InvalidJson);
        }
        self.require(b'[')?;
        self.whitespace();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(());
        }
        loop {
            self.value(depth)?;
            self.whitespace();
            match self.peek() {
                Some(b']') => {
                    self.position += 1;
                    return Ok(());
                }
                Some(b',') => {
                    self.position += 1;
                    self.whitespace();
                }
                _ => return Err(JsonScanError::InvalidJson),
            }
        }
    }

    fn string(&mut self) -> Result<String, JsonScanError> {
        let start = self.position;
        self.require(b'"')?;
        loop {
            match self.peek() {
                Some(b'"') => {
                    self.position += 1;
                    return serde_json::from_slice(&self.body[start..self.position])
                        .map_err(|_| JsonScanError::InvalidJson);
                }
                Some(b'\\') => {
                    self.position += 1;
                    if self.peek().is_none() {
                        return Err(JsonScanError::InvalidJson);
                    }
                    self.position += 1;
                }
                Some(0..=0x1f) | None => return Err(JsonScanError::InvalidJson),
                Some(_) => self.position += 1,
            }
        }
    }

    fn literal(&mut self, value: &[u8]) -> Result<(), JsonScanError> {
        if !self.body[self.position..].starts_with(value) {
            return Err(JsonScanError::InvalidJson);
        }
        self.position += value.len();
        Ok(())
    }

    fn number(&mut self) -> Result<(), JsonScanError> {
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.position += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(JsonScanError::InvalidJson),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            self.digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            self.digits()?;
        }
        Ok(())
    }

    fn digits(&mut self) -> Result<(), JsonScanError> {
        let start = self.position;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }
        if self.position == start {
            return Err(JsonScanError::InvalidJson);
        }
        Ok(())
    }
}
