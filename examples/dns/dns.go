package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"math/rand"
	"net"
	"strings"
	"syscall/js"
	"time"
)

type DNSHeader struct {
	ID      uint16
	Flags   uint16
	QDCount uint16
	ANCount uint16
	NSCount uint16
	ARCount uint16
}

type DNSQuestion struct {
	Name  string
	Type  uint16
	Class uint16
}

type DNSAnswer struct {
	Name  string
	Type  uint16
	Class uint16
	TTL   uint32
	Data  []byte
}

// BrowserSocket wraps a JavaScript BrowserSocket.Socket and implements net.Conn
type BrowserSocket struct {
	jsSocket js.Value
	readBuf  chan []byte
	closed   bool
}

// NewBrowserSocket creates a BrowserSocket from a JavaScript BrowserSocket.Socket
func NewBrowserSocket(jsSocket js.Value) *BrowserSocket {
	bs := &BrowserSocket{
		jsSocket: jsSocket,
		readBuf:  make(chan []byte, 10),
		closed:   false,
	}

	// Start reading from readable stream in background goroutine
	go bs.readFromStream()

	return bs
}

// readFromStream reads from the socket's readable stream
func (bs *BrowserSocket) readFromStream() {
	defer close(bs.readBuf)
	
	// Get the readable stream reader
	readableStream := bs.jsSocket.Get("readable")
	if readableStream.IsUndefined() {
		return
	}
	
	reader := readableStream.Call("getReader")
	
	for !bs.closed {
		// Read from stream
		readPromise := reader.Call("read")
		
		// Handle the promise
		done := make(chan bool, 1)
		var resultValue js.Value
		
		readPromise.Call("then", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
			if len(args) > 0 {
				resultValue = args[0]
			}
			done <- true
			return nil
		})).Call("catch", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
			done <- true
			return nil
		}))
		
		// Wait for promise to resolve with timeout
		select {
		case <-done:
			if !resultValue.IsUndefined() && !bs.closed {
				if resultValue.Get("done").Bool() {
					return // Stream ended
				}
				
				value := resultValue.Get("value")
				if !value.IsUndefined() {
					length := value.Get("length").Int()
					if length > 0 {
						buf := make([]byte, length)
						js.CopyBytesToGo(buf, value)
						
						select {
						case bs.readBuf <- buf:
						case <-time.After(time.Second):
							// Prevent blocking
						}
					}
				}
			}
		case <-time.After(5 * time.Second):
			// Timeout, continue loop
		}
		
		// Small delay to prevent busy loop
		time.Sleep(10 * time.Millisecond)
	}
}

// Read implements net.Conn
func (bs *BrowserSocket) Read(b []byte) (n int, err error) {
	if bs.closed {
		return 0, io.EOF
	}

	// Wait for data with timeout to avoid deadlock
	select {
	case data, ok := <-bs.readBuf:
		if !ok || data == nil {
			return 0, io.EOF
		}
		n = copy(b, data)
		return n, nil
	case <-time.After(10 * time.Second):
		return 0, fmt.Errorf("read timeout")
	}
}

// Write implements net.Conn
func (bs *BrowserSocket) Write(b []byte) (n int, err error) {
	if bs.closed {
		return 0, io.EOF
	}

	// Get the writable stream writer
	writableStream := bs.jsSocket.Get("writable")
	if writableStream.IsUndefined() {
		return 0, fmt.Errorf("writable stream not available")
	}
	
	writer := writableStream.Call("getWriter")
	
	// Convert to Uint8Array for JavaScript
	jsArray := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(jsArray, b)

	// Write to stream
	writePromise := writer.Call("write", jsArray)
	
	// For simplicity, don't wait for promise resolution
	// In production, you might want to handle the promise
	writePromise.Call("catch", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		// Handle write errors if needed
		return nil
	}))
	
	// Release the writer
	writer.Call("releaseLock")
	
	return len(b), nil
}

// Close implements net.Conn
func (bs *BrowserSocket) Close() error {
	if !bs.closed {
		bs.closed = true
		
		// Close the writable stream
		writableStream := bs.jsSocket.Get("writable")
		if !writableStream.IsUndefined() {
			writer := writableStream.Call("getWriter")
			closePromise := writer.Call("close")
			closePromise.Call("catch", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
				return nil
			}))
		}
		
		// Note: readBuf channel will be closed by readFromStream goroutine
	}
	return nil
}

// LocalAddr implements net.Conn
func (bs *BrowserSocket) LocalAddr() net.Addr {
	// Return a dummy address for now
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0}
}

// RemoteAddr implements net.Conn
func (bs *BrowserSocket) RemoteAddr() net.Addr {
	// Return a dummy address for now
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 53}
}

// SetDeadline implements net.Conn
func (bs *BrowserSocket) SetDeadline(t time.Time) error {
	return nil // Not implemented
}

// SetReadDeadline implements net.Conn
func (bs *BrowserSocket) SetReadDeadline(t time.Time) error {
	return nil // Not implemented
}

// SetWriteDeadline implements net.Conn
func (bs *BrowserSocket) SetWriteDeadline(t time.Time) error {
	return nil // Not implemented
}

func main() {
	// Register Go functions for JavaScript
	js.Global().Set("lookupDNS", js.FuncOf(lookupDNSWrapper))

	// Keep the Go program running
	select {}
}

// lookupDNSWrapper is the JavaScript-callable wrapper for lookupDNS
func lookupDNSWrapper(this js.Value, args []js.Value) interface{} {
	if len(args) < 3 {
		return js.Null()
	}

	domain := args[0].String()
	jsSocket := args[1]
	callback := args[2]

	// Run DNS lookup in a goroutine to avoid blocking
	go func() {
		// Create BrowserSocket from JavaScript Socket
		bs := NewBrowserSocket(jsSocket)
		defer bs.Close()

		// Perform DNS lookup
		result, err := lookupDNS(domain, bs)
		if err != nil {
			// Call callback with error
			callback.Invoke(createError(fmt.Sprintf("DNS lookup failed: %v", err)), js.Null())
		} else {
			// Call callback with success
			callback.Invoke(js.Null(), result)
		}
	}()

	return js.Undefined()
}

// lookupDNS performs DNS lookup using a net.Conn (BrowserSocket)
func lookupDNS(domain string, conn net.Conn) (js.Value, error) {
	// Create DNS header
	queryID := uint16(rand.Intn(65536))
	header := DNSHeader{
		ID:      queryID,
		Flags:   0x0100, // Standard query with recursion desired
		QDCount: 1,
		ANCount: 0,
		NSCount: 0,
		ARCount: 0,
	}

	// Build DNS packet
	packet := make([]byte, 12) // Header size

	// Write header
	binary.BigEndian.PutUint16(packet[0:2], header.ID)
	binary.BigEndian.PutUint16(packet[2:4], header.Flags)
	binary.BigEndian.PutUint16(packet[4:6], header.QDCount)
	binary.BigEndian.PutUint16(packet[6:8], header.ANCount)
	binary.BigEndian.PutUint16(packet[8:10], header.NSCount)
	binary.BigEndian.PutUint16(packet[10:12], header.ARCount)

	// Add question section
	question := encodeDomainName(domain)
	packet = append(packet, question...)

	// Add type (A record = 1) and class (IN = 1)
	packet = append(packet, 0x00, 0x01) // Type A
	packet = append(packet, 0x00, 0x01) // Class IN

	// For TCP, prepend 2-byte length prefix
	tcpPacket := make([]byte, 2+len(packet))
	binary.BigEndian.PutUint16(tcpPacket[0:2], uint16(len(packet)))
	copy(tcpPacket[2:], packet)

	// Send DNS query
	_, err := conn.Write(tcpPacket)
	if err != nil {
		return js.Value{}, fmt.Errorf("failed to send DNS query: %v", err)
	}

	// Read response
	responseBuffer := make([]byte, 1024)
	n, err := conn.Read(responseBuffer)
	if err != nil {
		return js.Value{}, fmt.Errorf("failed to read DNS response: %v", err)
	}

	response := responseBuffer[:n]

	// Parse the response
	return parseDNSResponseTCP(response, queryID)
}

func encodeDomainName(domain string) []byte {
	var result []byte

	// Remove trailing dot if present
	domain = strings.TrimSuffix(domain, ".")

	// Split by dots and encode each label
	labels := strings.Split(domain, ".")
	for _, label := range labels {
		if len(label) > 0 {
			result = append(result, byte(len(label)))
			result = append(result, []byte(label)...)
		}
	}

	// Add null terminator
	result = append(result, 0)

	return result
}

func parseDomainName(data []byte, offset int) (string, int) {
	var name []string
	originalOffset := offset
	jumped := false

	for offset < len(data) {
		length := data[offset]

		// Check for compression pointer
		if length&0xC0 == 0xC0 {
			if offset+1 >= len(data) {
				break
			}
			// Get pointer offset
			pointer := int(binary.BigEndian.Uint16(data[offset:offset+2]) & 0x3FFF)
			if !jumped {
				originalOffset = offset + 2
				jumped = true
			}
			offset = pointer
			continue
		}

		// End of name
		if length == 0 {
			offset++
			break
		}

		// Read label
		if offset+1+int(length) > len(data) {
			break
		}
		name = append(name, string(data[offset+1:offset+1+int(length)]))
		offset += 1 + int(length)
	}

	if jumped {
		offset = originalOffset
	}

	return strings.Join(name, "."), offset
}

func getRecordType(t uint16) string {
	switch t {
	case 1:
		return "A"
	case 5:
		return "CNAME"
	case 28:
		return "AAAA"
	case 15:
		return "MX"
	case 16:
		return "TXT"
	case 2:
		return "NS"
	case 12:
		return "PTR"
	case 6:
		return "SOA"
	default:
		return fmt.Sprintf("TYPE%d", t)
	}
}

// parseDNSResponseTCP parses a DNS response and returns JavaScript-compatible result
func parseDNSResponseTCP(response []byte, expectedID uint16) (js.Value, error) {
	if len(response) < 2 {
		return js.Value{}, fmt.Errorf("TCP response too short - missing length prefix")
	}

	// Parse TCP length prefix (first 2 bytes)
	messageLength := binary.BigEndian.Uint16(response[0:2])

	if len(response) < int(2+messageLength) {
		return js.Value{}, fmt.Errorf("incomplete TCP DNS message")
	}

	// Extract the DNS message (skip the 2-byte length prefix)
	dnsMessage := response[2 : 2+messageLength]

	if len(dnsMessage) < 12 {
		return js.Value{}, fmt.Errorf("DNS message too short")
	}

	// Parse header
	header := DNSHeader{
		ID:      binary.BigEndian.Uint16(dnsMessage[0:2]),
		Flags:   binary.BigEndian.Uint16(dnsMessage[2:4]),
		QDCount: binary.BigEndian.Uint16(dnsMessage[4:6]),
		ANCount: binary.BigEndian.Uint16(dnsMessage[6:8]),
		NSCount: binary.BigEndian.Uint16(dnsMessage[8:10]),
		ARCount: binary.BigEndian.Uint16(dnsMessage[10:12]),
	}

	// Verify query ID matches
	if header.ID != expectedID {
		return js.Value{}, fmt.Errorf("query ID mismatch: expected %d, got %d", expectedID, header.ID)
	}

	// Check for errors in flags
	rcode := header.Flags & 0x0F
	if rcode != 0 {
		return js.Value{}, fmt.Errorf("DNS error: RCODE %d", rcode)
	}

	offset := 12

	// Skip question section
	for i := uint16(0); i < header.QDCount; i++ {
		// Skip domain name
		for offset < len(dnsMessage) && dnsMessage[offset] != 0 {
			if dnsMessage[offset]&0xC0 == 0xC0 {
				offset += 2
				break
			}
			offset += int(dnsMessage[offset]) + 1
		}
		if offset < len(dnsMessage) && dnsMessage[offset] == 0 {
			offset++ // Skip null terminator
		}
		offset += 4 // Skip type and class
	}

	// Parse answer section
	result := js.Global().Get("Object").New()
	result.Set("answerCount", header.ANCount)
	result.Set("success", true)

	answers := js.Global().Get("Array").New()

	for i := uint16(0); i < header.ANCount && offset < len(dnsMessage); i++ {
		answer := js.Global().Get("Object").New()

		// Parse name (often compressed)
		name, newOffset := parseDomainName(dnsMessage, offset)
		offset = newOffset

		if offset+10 > len(dnsMessage) {
			break
		}

		// Parse type, class, TTL, and data length
		ansType := binary.BigEndian.Uint16(dnsMessage[offset : offset+2])
		ansClass := binary.BigEndian.Uint16(dnsMessage[offset+2 : offset+4])
		ttl := binary.BigEndian.Uint32(dnsMessage[offset+4 : offset+8])
		dataLen := binary.BigEndian.Uint16(dnsMessage[offset+8 : offset+10])
		offset += 10

		if offset+int(dataLen) > len(dnsMessage) {
			break
		}

		answer.Set("name", name)
		answer.Set("type", getRecordType(ansType))
		answer.Set("class", ansClass)
		answer.Set("ttl", ttl)

		// Parse data based on type
		if ansType == 1 && dataLen == 4 { // A record
			ip := fmt.Sprintf("%d.%d.%d.%d",
				dnsMessage[offset], dnsMessage[offset+1],
				dnsMessage[offset+2], dnsMessage[offset+3])
			answer.Set("data", ip)
		} else if ansType == 5 { // CNAME record
			cname, _ := parseDomainName(dnsMessage, offset)
			answer.Set("data", cname)
		} else {
			// For other types, just show hex
			hexData := fmt.Sprintf("%x", dnsMessage[offset:offset+int(dataLen)])
			answer.Set("data", hexData)
		}

		offset += int(dataLen)
		answers.Call("push", answer)
	}

	result.Set("answers", answers)
	return result, nil
}

func createError(message string) js.Value {
	result := js.Global().Get("Object").New()
	result.Set("success", false)
	result.Set("error", message)
	return result
}

func init() {}
