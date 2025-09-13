# Contributing to browser-socket

Thank you for your interest in contributing to browser-socket! This project enables real TCP networking in browsers, and we welcome contributions that help expand its capabilities.

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Basic understanding of TCP networking and WebSockets

### Development Setup

1. **Fork and clone the repository:**

```bash
git clone https://github.com/your-username/browser-socket.git
cd browser-socket
```

2. **Install dependencies:**

```bash
# Server
cd server && npm install

# Client
cd ../client && npm install
```

3. **Build and test:**

```bash
# Server
cd server && npm run build

# Client
cd ../client && npm run build
```

4. **Run examples:**

```bash
# Start demo server
cd demo-server && npm install && npm start

# Open examples in browser
open examples/web-server/index.html
open examples/dns/index.html
```

## 📋 How to Contribute

### 🐛 Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template
3. Include:
   - Browser and Node.js versions
   - Minimal reproduction case
   - Expected vs actual behavior
   - Console errors/logs

### 💡 Suggesting Features

1. Open an issue with the feature request template
2. Describe the use case and benefit
3. Consider implementation complexity
4. Be open to discussion and alternatives

### 🔧 Code Contributions

#### What We Need Help With

- **Protocol improvements** - Enhance the binary wire protocol
- **Performance optimizations** - Reduce latency and improve throughput
- **Browser compatibility** - Test and fix issues across browsers
- **Error handling** - Better error messages and recovery
- **Documentation** - API docs, tutorials, examples
- **Examples** - Creative demos showing new possibilities
- **Security** - Audit and improve security measures

#### Development Guidelines

1. **Follow existing patterns:**

   - Look at existing code style and conventions
   - Use the same libraries and utilities already in the codebase
   - Match naming conventions and file structure

2. **Keep dependencies minimal:**

   - No third-party libraries except built-in Node.js modules
   - Client-side code should be vanilla JavaScript/TypeScript
   - Server uses only the `ws` WebSocket library

3. **Write modular, readable code:**

   - Prioritize readability over premature optimization
   - Keep functions focused and well-named
   - Add comments for complex protocol logic

4. **Test your changes:**
   - Verify examples still work
   - Test with multiple browser types
   - Check both client and server functionality

#### Pull Request Process

1. **Create a feature branch:**

```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes:**

   - Follow the coding guidelines above
   - Keep commits focused and well-described
   - Update documentation if needed

3. **Test thoroughly:**

   - Build both client and server
   - Run existing examples
   - Test your new functionality

4. **Submit the PR:**

   - Use the pull request template
   - Describe what you changed and why
   - Link any related issues
   - Include testing instructions

5. **Respond to feedback:**
   - Be open to suggestions and changes
   - Update your branch as requested
   - Maintain a collaborative attitude

## 🏗 Architecture Notes

### Key Components

- **Server (`/server/src/`)**: WebSocket transport and TCP connection handling
- **Client (`/client/src/`)**: Browser-compatible TCP socket API
- **Examples (`/examples/`)**: Demo applications

### Wire Protocol

- 8-byte header: Length(24) + Flag(8) + StreamID(32)
- Flags: DATA(0), SYN(1), ACK(2), FIN(4), RST(8), LISTEN(16)
- Stream multiplexing with unique IDs
- Binary payload for efficiency

#### Protocol Design Principles

- **Client-triggered actions should not trigger event emission** - Actions initiated by the client should not cause events to be emitted back to the client to prevent feedback loops
- **Invalid protocol format should trigger reset of stream** - Any malformed or invalid protocol data should immediately reset the affected stream to maintain protocol integrity
- **RST is a final state and should not trigger further actions** - Reset frames represent terminal state and should not generate replies or additional payload processing

### Testing Strategy

- Manual testing with examples
- Cross-browser compatibility checks
- Performance testing with multiple connections
- Protocol compliance verification

## 🔒 Security Considerations

- Never expose sensitive data in logs
- Validate all input data
- Implement proper access controls
- Consider rate limiting and DoS protection
- Use secure WebSocket connections (WSS) in production

## 📚 Documentation

### Code Comments

- Comment complex protocol logic
- Explain non-obvious design decisions
- Document public APIs clearly
- Keep comments up-to-date with code changes

### Examples

- Create clear, focused examples
- Include step-by-step setup instructions
- Show both basic and advanced usage
- Test examples across browsers

## 🤝 Community Guidelines

- **Be respectful** - Treat all contributors with kindness
- **Be collaborative** - Work together to find the best solutions
- **Be patient** - Reviews and responses may take time
- **Be constructive** - Focus on improving the project
- **Be inclusive** - Welcome contributors of all skill levels

## 📞 Getting Help

- **GitHub Issues** - For bugs, features, and questions
- **Discussions** - For general questions and brainstorming
- **Email** - Reach out to maintainers for private issues

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for helping make browser networking more powerful! 🚀**
