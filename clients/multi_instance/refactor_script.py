#!/usr/bin/env python3
"""
Script to refactor multi_spectrum_gui.py to use separate instance windows.
This script reads the original file and creates a refactored version.
"""

import re

def refactor_file():
    # Read the original file
    with open('multi_spectrum_gui.py', 'r') as f:
        content = f.read()
    
    # The InstanceWindow class is already added at the beginning
    # Now we need to make the following changes:
    
    # 1. Remove spectrum_container from __init__
    content = re.sub(
        r"self\.spectrum_container = None\n",
        "",
        content
    )
    
    # 2. Update geometry
    content = re.sub(
        r'self\.root\.geometry\("1500x900"\)',
        'self.root.geometry("800x600")',
        content
    )
    
    # 3. Remove modes section from create_widgets (lines 401-422)
    modes_section = r"""        # Modes section \(between instance list and spectrum displays\)
        # This will now be a scrollable container for per-instance controls
        modes_outer_frame = ttk\.LabelFrame\(main_frame, text="Modes \(Per-Instance Controls\)", padding="10"\)
        modes_outer_frame\.grid\(row=2, column=0, sticky=\(tk\.W, tk\.E\), pady=\(0, 10\)\)
        
        # Scrollable modes container
        modes_canvas = tk\.Canvas\(modes_outer_frame, height=150\)
        modes_scrollbar = ttk\.Scrollbar\(modes_outer_frame, orient="vertical", command=modes_canvas\.yview\)
        self\.modes_container = ttk\.Frame\(modes_canvas\)
        
        modes_canvas\.create_window\(\(0, 0\), window=self\.modes_container, anchor="nw"\)
        modes_canvas\.configure\(yscrollcommand=modes_scrollbar\.set\)
        
        modes_canvas\.pack\(side=tk\.LEFT, fill=tk\.BOTH, expand=True\)
        modes_scrollbar\.pack\(side=tk\.RIGHT, fill=tk\.Y\)
        
        # Update scroll region when frame changes
        self\.modes_container\.bind\("<Configure>",
                                 lambda e: modes_canvas\.configure\(scrollregion=modes_canvas\.bbox\("all"\)\)\)
        
        # Store reference to per-instance control widgets
        self\.instance_mode_controls = \{\}  # instance_id -> dict of control widgets

"""
    content = re.sub(modes_section, "", content, flags=re.MULTILINE)
    
    # 4. Remove spectrum displays section (lines 498-523)
    spectrum_section = r"""        # Spectrum display area \(bottom\)
        spectrum_frame = ttk\.LabelFrame\(main_frame, text="Spectrum Displays", padding="10"\)
        spectrum_frame\.grid\(row=4, column=0, sticky=\(tk\.W, tk\.E, tk\.N, tk\.S\)\)
        
        # Scrollable spectrum container
        spectrum_canvas = tk\.Canvas\(spectrum_frame\)
        spectrum_scrollbar = ttk\.Scrollbar\(spectrum_frame, orient="vertical", 
                                          command=spectrum_canvas\.yview\)
        self\.spectrum_container = ttk\.Frame\(spectrum_canvas\)
        
        spectrum_canvas\.create_window\(\(0, 0\), window=self\.spectrum_container, anchor="nw"\)
        spectrum_canvas\.configure\(yscrollcommand=spectrum_scrollbar\.set\)
        
        spectrum_canvas\.pack\(side=tk\.LEFT, fill=tk\.BOTH, expand=True\)
        spectrum_scrollbar\.pack\(side=tk\.RIGHT, fill=tk\.Y\)
        
        # Update scroll region when frame changes
        self\.spectrum_container\.bind\("<Configure>", 
                                    lambda e: spectrum_canvas\.configure\(scrollregion=spectrum_canvas\.bbox\("all"\)\)\)
        
        # Configure weights for resizing
        main_frame\.columnconfigure\(0, weight=1\)
        main_frame\.rowconfigure\(1, weight=0\)  # Instance list fixed height
        main_frame\.rowconfigure\(2, weight=0\)  # Modes section fixed height
        main_frame\.rowconfigure\(3, weight=0\)  # Audio preview section fixed height
        main_frame\.rowconfigure\(4, weight=1\)  # Spectrum area expands"""
    
    content = re.sub(spectrum_section, """        # Configure weights for resizing
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(1, weight=1)  # Instance list expands
        main_frame.rowconfigure(2, weight=0)  # Audio preview section fixed height (if present)""", content, flags=re.MULTILINE)
    
    # 5. Remove create_instance_mode_controls method (it's no longer needed)
    # This is complex, so we'll mark it for manual review
    
    # 6. Update connect_instance to create InstanceWindow
    old_connect = r"""    def connect_instance\(self, instance: SpectrumInstance\):
        \"\"\"Connect a single instance\.\"\"\"
        # Update button text
        if hasattr\(instance, 'connect_btn'\):
            instance\.connect_btn\.config\(text="Disconnect"\)
        
        # Create spectrum display if not exists
        if instance\.spectrum is None:
            spectrum_frame = ttk\.LabelFrame\(self\.spectrum_container,
                                           text=instance\.get_display_name\(\), padding="5"\)
            spectrum_frame\.pack\(fill=tk\.BOTH, expand=True, pady=5\)
            
            # Store reference to the frame for later cleanup
            instance\.spectrum_frame = spectrum_frame"""
    
    new_connect = """    def connect_instance(self, instance: SpectrumInstance):
        \"\"\"Connect a single instance.\"\"\"
        # Update button text
        if hasattr(instance, 'connect_btn'):
            instance.connect_btn.config(text="Disconnect")
        
        # Create instance window if not exists
        if not hasattr(instance, 'instance_window') or instance.instance_window is None:
            instance_window = InstanceWindow(self, instance)
        
        # Create spectrum display if not exists
        if instance.spectrum is None:
            # Get the spectrum frame from the instance window
            spectrum_frame = instance.instance_window.spectrum_frame"""
    
    content = re.sub(old_connect, new_connect, content, flags=re.MULTILINE | re.DOTALL)
    
    print("Refactoring complete!")
    print("\nNote: Due to the complexity of this file, some manual adjustments may be needed.")
    print("Please review the changes carefully, especially:")
    print("1. The create_instance_mode_controls method should be removed")
    print("2. All references to self.instance_mode_controls should be updated")
    print("3. The disconnect_instance method needs to close instance windows")
    print("4. The remove_instance method needs updating")
    
    # Write the refactored content
    with open('multi_spectrum_gui_refactored_auto.py', 'w') as f:
        f.write(content)
    
    print("\nRefactored file written to: multi_spectrum_gui_refactored_auto.py")

if __name__ == '__main__':
    refactor_file()