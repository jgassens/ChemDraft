//! Stoppable loopback servers and bounded, graceful HTTP replies for download tests.
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub(crate) struct LoopbackServer {
    stop: mpsc::Sender<()>,
    thread: thread::JoinHandle<usize>,
}

impl LoopbackServer {
    pub(crate) fn spawn(
        listener: TcpListener,
        connections: usize,
        mut serve: impl FnMut(TcpStream) + Send + 'static,
    ) -> Self {
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        // Dropping the handle (including on panic) disconnects the channel and stops accepting.
        let (stop, stopped) = mpsc::channel();
        let thread = thread::spawn(move || {
            let mut served = 0;
            while served < connections {
                match listener.accept() {
                    Ok((stream, _)) => {
                        serve(stream);
                        served += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if !matches!(
                            stopped.recv_timeout(Duration::from_millis(5)),
                            Err(mpsc::RecvTimeoutError::Timeout)
                        ) {
                            break;
                        }
                    }
                    Err(error) => panic!("loopback accept failed at {address}: {error}"),
                }
            }
            served
        });
        Self { stop, thread }
    }

    pub(crate) fn join(self) -> thread::Result<()> {
        let served = self.join_served_count()?;
        assert!(served > 0, "loopback server did not serve a client");
        Ok(())
    }

    pub(crate) fn join_unused(self) -> thread::Result<()> {
        assert_eq!(self.join_served_count()?, 0, "loopback server was used");
        Ok(())
    }

    pub(crate) fn join_served_count(self) -> thread::Result<usize> {
        // Joining means all client calls are done; stop even if none connected.
        drop(self.stop);
        self.thread.join()
    }
}

pub(crate) fn reply(mut stream: TcpStream, response: &[u8]) {
    // Accepted sockets inherit the listener's nonblocking mode on Windows; read timeouts only apply to blocking sockets.
    stream.set_nonblocking(false).expect("blocking test stream");
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
        stream
            .set_read_timeout(Some(remaining))
            .expect("incomplete HTTP request headers: failed to set read timeout");
        let limit = buffer.len().min(HEADER_LIMIT - request.len());
        let count = stream
            .read(&mut buffer[..limit])
            .expect("failed to read complete HTTP request headers");
        assert_ne!(count, 0, "incomplete HTTP request headers");
        request.extend_from_slice(&buffer[..count]);
    }
    stream.write_all(response).expect("HTTP response");
    // The peer may already have closed after receiving the complete response.
    let _ = stream.shutdown(Shutdown::Write);
    // Dropping with unread input can send a TCP reset on Windows and discard the response.
    let deadline = Instant::now() + Duration::from_millis(200);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if stream.set_read_timeout(Some(remaining)).is_err() {
            break;
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}
