FROM ubuntu:22.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV DISPLAY=:99

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Install Chrome dependencies and Chrome
RUN apt-get update && apt-get install -y \
    chromium-browser \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    alsa-utils \
    jq \
    x11vnc \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Install additional audio dependencies
RUN apt-get update && apt-get install -y \
    libasound2-dev \
    libpulse-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --only=production

# Copy application files
COPY . .

# Make shell scripts executable
RUN chmod +x *.sh

# Create necessary directories
RUN mkdir -p /tmp/realtime-sessions /tmp/.X11-unix

# Set up PulseAudio for audio capture
RUN mkdir -p /etc/pulse
COPY <<EOF /etc/pulse/default.pa
#!/usr/bin/pulseaudio -nF
#
# This file is part of PulseAudio.
#
# PulseAudio is free software; you can redistribute it and/or modify it
# under the terms of the GNU Lesser General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# PulseAudio is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public License
# along with PulseAudio; if not, see <http://www.gnu.org/licenses/>.

# This startup script is used when PulseAudio is started in system
# mode.

### Load core protocols modules
load-module module-native-protocol-unix auth-anonymous=1 socket=/tmp/pulse-socket

### Make sure we always have a sink/source, even if something is wrong with the
### hardware detection
load-module module-always-sink

### Enable positioned event sounds
load-module module-position-event-sounds

### Enable autodetect on bluetooth devices
load-module module-bluetooth-discover

### Load virtual sink for audio capture
load-module module-null-sink sink_name=audio_sink sink_properties=device.description=Virtual_Audio_Sink

### Load virtual source for audio capture
load-module module-null-source source_name=audio_source source_properties=device.description=Virtual_Audio_Source

### Load loopback module to connect virtual sink to virtual source
load-module module-loopback source=audio_source sink=audio_sink

### Load virtual sink for display audio
load-module module-null-sink sink_name=audio_sink_display sink_properties=device.description=Display_Audio_Sink

### Load monitor source for display audio
load-module module-null-source source_name=audio_sink_display.monitor source_properties=device.description=Display_Audio_Monitor
EOF

# Create startup script
RUN echo '#!/bin/bash\n\
# Start PulseAudio\n\
pulseaudio --start --log-level=4 --file=/etc/pulse/default.pa\n\
\n\
# Start virtual display\n\
Xvfb :99 -screen 0 1280x800x24 &\n\
\n\
# Wait for display to be ready\n\
sleep 2\n\
\n\
# Start the application\n\
exec node server.js' > /app/start.sh && chmod +x /app/start.sh

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["/app/start.sh"]
