"""
Instance Manager
Handles connection and management of multiple spectrum instances
"""

import uuid
import aiohttp
import asyncio
import time
from typing import List, Optional, Tuple
from tkinter import messagebox

from spectrum_instance import SpectrumInstance


class InstanceManager:
    """Manages multiple spectrum instances."""
    
    def __init__(self, max_instances: int = 10):
        self.max_instances = max_instances
        self.instances: List[SpectrumInstance] = []
        self.active_instances: List[SpectrumInstance] = []
    
    def can_add_instance(self) -> bool:
        """Check if we can add more instances."""
        return len(self.instances) < self.max_instances
    
    def add_instance(self, instance: SpectrumInstance) -> bool:
        """Add a new instance."""
        if not self.can_add_instance():
            return False
        self.instances.append(instance)
        return True
    
    def remove_instance(self, instance: SpectrumInstance):
        """Remove an instance."""
        if instance in self.instances:
            self.instances.remove(instance)
        if instance in self.active_instances:
            self.active_instances.remove(instance)
    
    def get_instance_by_id(self, instance_id: int) -> Optional[SpectrumInstance]:
        """Get instance by ID."""
        for instance in self.instances:
            if instance.instance_id == instance_id:
                return instance
        return None
    
    async def fetch_server_info(self, instance: SpectrumInstance) -> bool:
        """Fetch server information from /api/description endpoint.

        Args:
            instance: The spectrum instance to fetch info for

        Returns:
            True if successful, False if server is unreachable
        """
        protocol = 'https' if instance.tls else 'http'
        description_url = f"{protocol}://{instance.host}:{instance.port}/api/description"

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    description_url,
                    headers={'User-Agent': 'UberSDR Multi-Instance Client 1.0 (python)'},
                    ssl=False if not instance.tls else None,
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        # Store spectrum poll period from server
                        instance.spectrum_poll_period = data.get('spectrum_poll_period', 100)
                        print(f"{instance.name}: Server spectrum poll period = {instance.spectrum_poll_period}ms ({instance.update_rate_hz:.1f} Hz)")
                        return True
                    else:
                        print(f"Failed to fetch server info for {instance.name}: HTTP {response.status}")
                        return False
        except Exception as e:
            print(f"Failed to fetch server info for {instance.name}: {e}")
            # Return False to indicate server is unreachable
            return False
    
    async def check_connection_allowed(self, instance: SpectrumInstance) -> Tuple[bool, str]:
        """Check if connection is allowed via /connection endpoint.
        
        Args:
            instance: The spectrum instance to check
            
        Returns:
            Tuple of (allowed, reason) where:
            - allowed: True if connection is allowed, False otherwise
            - reason: Rejection reason if not allowed, empty string if allowed
        """
        # Build HTTP URL for connection check
        protocol = 'https' if instance.tls else 'http'
        http_url = f"{protocol}://{instance.host}:{instance.port}/connection"
        
        # Prepare request body
        request_body = {
            "user_session_id": instance.user_session_id
        }
        
        # Add password if provided
        if instance.password:
            request_body["password"] = instance.password
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    http_url,
                    json=request_body,
                    headers={
                        'Content-Type': 'application/json',
                        'User-Agent': 'UberSDR Multi-Instance Client 1.0 (python)'
                    },
                    ssl=False if not instance.tls else None,
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    data = await response.json()
                    
                    if not data.get('allowed', False):
                        reason = data.get('reason', 'Unknown reason')
                        return False, reason
                    
                    # Store connection metadata
                    instance.bypassed = data.get('bypassed', False)
                    instance.allowed_iq_modes = data.get('allowed_iq_modes', [])
                    instance.max_session_time = data.get('max_session_time', 0)
                    instance.connection_start_time = time.time()
                    
                    return True, ""
                    
        except Exception as e:
            error_msg = str(e)
            print(f"Connection check failed for {instance.name}: {error_msg}")
            # Return False to prevent connection attempt when server is unreachable
            return False, f"Connection check failed: {error_msg}"
    
    def connect_instance(self, instance: SpectrumInstance, spectrum_display) -> bool:
        """Connect a single instance."""
        if not instance.enabled:
            messagebox.showinfo("Instance Disabled",
                              f"{instance.name} is disabled. Enable it first.")
            return False
        
        if instance.connected:
            return True
        
        try:
            # Generate session ID if not exists
            if not instance.user_session_id:
                instance.user_session_id = str(uuid.uuid4())
            
            # Fetch server info and check if connection is allowed (run async in sync context)
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Fetch server information first
                server_reachable = loop.run_until_complete(self.fetch_server_info(instance))

                if not server_reachable:
                    messagebox.showerror("Connection Error",
                                       f"Cannot reach {instance.name} at {instance.host}:{instance.port}\n\n"
                                       f"Please check:\n"
                                       f"- Server is running\n"
                                       f"- Host and port are correct\n"
                                       f"- Network connectivity")
                    return False

                # Then check if connection is allowed
                allowed, reason = loop.run_until_complete(
                    self.check_connection_allowed(instance)
                )
            finally:
                loop.close()

            if not allowed:
                messagebox.showerror("Connection Rejected",
                                   f"{instance.name}: {reason}")
                return False
            
            # Build server URL
            server = f"{instance.host}:{instance.port}"
            
            # Connect spectrum
            spectrum_display.connect(server, instance.frequency, instance.user_session_id,
                                    use_tls=instance.tls, password=instance.password)
            
            instance.connected = True
            if instance not in self.active_instances:
                self.active_instances.append(instance)
            
            return True
            
        except Exception as e:
            messagebox.showerror("Connection Error",
                               f"Failed to connect {instance.name}: {e}")
            return False
    
    def disconnect_instance(self, instance: SpectrumInstance) -> bool:
        """Disconnect a single instance."""
        if not instance.connected:
            return True
        
        try:
            if instance.spectrum:
                instance.spectrum.disconnect()
            
            instance.connected = False
            
            if instance in self.active_instances:
                self.active_instances.remove(instance)
            
            return True
                
        except Exception as e:
            print(f"Error disconnecting {instance.name}: {e}")
            return False
    
    def connect_all_enabled(self, spectrum_displays: dict) -> int:
        """Connect all enabled instances. Returns count of successful connections."""
        count = 0
        for instance in self.instances:
            if instance.enabled and not instance.connected:
                if instance.instance_id in spectrum_displays:
                    if self.connect_instance(instance, spectrum_displays[instance.instance_id]):
                        count += 1
        return count
    
    def disconnect_all(self) -> int:
        """Disconnect all instances. Returns count of disconnected instances."""
        count = 0
        for instance in list(self.active_instances):
            if self.disconnect_instance(instance):
                count += 1
        return count
    
    def get_enabled_instances(self) -> List[SpectrumInstance]:
        """Get list of enabled instances."""
        return [inst for inst in self.instances if inst.enabled]
    
    def get_connected_instances(self) -> List[SpectrumInstance]:
        """Get list of connected instances."""
        return list(self.active_instances)