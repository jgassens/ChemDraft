//! Bounded, graceful HTTP replies for loopback download tests.
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream},
    time::{Duration, Instant},
};

pub(crate) fn reply(mut stream: TcpStream, response: &[u8]) {
    const HEADER_LIMIT: usize = 64 * 1024;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        assert!(
            request.len() < HEADER_LIMIT,
            "HTTP request headers too large"
        );
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "HTTP request headers timed out");
        stream.set_read_timeout(Some(remaining)).unwrap();
        let limit = buffer.len().min(HEADER_LIMIT - request.len());
        let count = stream.read(&mut buffer[..limit]).expect("request headers");
        assert_ne!(count, 0, "incomplete HTTP request headers");
        request.extend_from_slice(&buffer[..count]);
    }
    stream.write_all(response).expect("HTTP response");
    stream
        .shutdown(Shutdown::Write)
        .expect("finish HTTP response");
    // Dropping with unread input can send a TCP reset on Windows and discard the response.
    let deadline = Instant::now() + Duration::from_millis(200);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(remaining)).unwrap();
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}
