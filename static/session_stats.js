// Session Statistics Visualization
// Fetches data from /api/session-stats and displays it using Chart.js

let countriesChart = null;
let durationChart = null;
let weekdayChart = null;
let hourlyChart = null;
let browsersChart = null;
let osChart = null;
let bandsChart = null;
let modesChart = null;
let receiverLocation = null;
let receiverInfo = null;

// Load receiver information
async function loadReceiverInfo() {
    try {
        const response = await fetch('/api/description');
        if (!response.ok) {
            console.warn('Failed to load receiver information');
            return;
        }
        
        const data = await response.json();
        
        // Update subtitle with receiver name
        const subtitleEl = document.getElementById('receiver-name');
        if (subtitleEl && data.receiver && data.receiver.name) {
            subtitleEl.textContent = data.receiver.name;
        }
        
        // Store receiver location for map marker
        if (data.receiver && data.receiver.gps) {
            receiverLocation = {
                lat: data.receiver.gps.lat,
                lon: data.receiver.gps.lon
            };
            
            receiverInfo = {
                name: data.receiver.name || null,
                location: data.receiver.location || null,
                callsign: data.receiver.callsign || null
            };
        }
    } catch (error) {
        console.error('Error loading receiver information:', error);
    }
}

// Fetch and display statistics
async function loadStatistics() {
    // Load receiver info first
    await loadReceiverInfo();
    
    try {
        const response = await fetch('/api/session-stats');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Hide loading, show content
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        
        // Update summary stats
        document.getElementById('total-sessions').textContent = data.stats.total_sessions.toLocaleString();
        document.getElementById('unique-users').textContent = data.stats.unique_users.toLocaleString();
        document.getElementById('unique-countries').textContent = data.stats.unique_countries.toLocaleString();
        
        // Create charts
        createWorldMap(data.stats.countries);
        createCountriesChart(data.stats.countries);
        createDurationChart(data.stats.duration_buckets);
        createBrowsersChart(data.stats.top_browsers);
        createOSChart(data.stats.top_operating_systems);
        createWeekdayChart(data.stats.avg_weekday_activity);
        createHourlyChart(data.stats.avg_hourly_activity);
        createBandsChart(data.stats.top_bands);
        createModesChart(data.stats.top_modes);
        
    } catch (error) {
        console.error('Error loading statistics:', error);
        document.getElementById('loading').style.display = 'none';
        const errorDiv = document.getElementById('error');
        errorDiv.textContent = `❌ Error loading statistics: ${error.message}`;
        errorDiv.style.display = 'block';
    }
}

// Create world map choropleth
async function createWorldMap(countries) {
    try {
        // Load world map data
        const response = await fetch('countries-110m.json');
        const world = await response.json();
        const worldCountries = topojson.feature(world, world.objects.countries);
        
        // Create arrays for country totals and individual locations
        const countryTotals = new Map(); // country name -> total sessions
        const allLocations = []; // all individual location markers
        let maxCountrySessions = 0;
        let maxLocationSessions = 0;
        
        countries.forEach(c => {
            // Track country totals for coloring polygons
            countryTotals.set(c.country, c.sessions);
            if (c.sessions > maxCountrySessions) {
                maxCountrySessions = c.sessions;
            }
            
            // Track individual locations for markers
            if (c.locations && c.locations.length > 0) {
                c.locations.forEach(loc => {
                    allLocations.push({
                        country: c.country,
                        code: c.country_code,
                        lat: loc.latitude,
                        lon: loc.longitude,
                        sessions: loc.sessions
                    });
                    if (loc.sessions > maxLocationSessions) {
                        maxLocationSessions = loc.sessions;
                    }
                });
            }
        });
        
        console.log('Country totals:', countryTotals);
        console.log('All locations:', allLocations);
        console.log('Max country sessions:', maxCountrySessions);
        console.log('Max location sessions:', maxLocationSessions);
        
        // Set up SVG
        const svg = d3.select('#worldMap');
        const container = svg.node().parentElement;
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        svg.attr('width', width)
           .attr('height', height);
        
        // Clear any existing content
        svg.selectAll('*').remove();
        
        // Create projection
        const projection = d3.geoNaturalEarth1()
            .fitSize([width, height], worldCountries);
        
        const path = d3.geoPath().projection(projection);
        
        // Create a group for all map elements (for zooming)
        const mapGroup = svg.append('g');
        
        // Add zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([1, 8]) // Allow zoom from 1x to 8x
            .on('zoom', (event) => {
                mapGroup.attr('transform', event.transform);
                
                // Counter-scale markers so they maintain visual size
                const scale = event.transform.k;
                
                // Scale listener location markers
                mapGroup.selectAll('circle')
                    .each(function(d) {
                        const circle = d3.select(this);
                        // Check if this is a receiver marker (has class receiver-marker parent)
                        const isReceiverMarker = circle.node().parentElement.classList.contains('receiver-marker');
                        
                        if (isReceiverMarker) {
                            // Receiver marker has fixed size
                            circle.attr('r', 8 / scale)
                                .style('stroke-width', 2 / scale);
                        } else if (d && d.sessions !== undefined) {
                            // Listener location markers scale based on sessions
                            circle.attr('r', markerSizeScale(d.sessions) / scale)
                                .style('stroke-width', 1 / scale);
                        }
                    });
            });
        
        svg.call(zoom);
        
        // Create color scale for countries (blue gradient)
        // Use log scale for better color distribution when there's a large range
        const countryColorScale = d3.scaleSequentialLog()
            .domain([1, maxCountrySessions]) // Start at 1 to avoid log(0)
            .interpolator(d3.interpolateBlues)
            .clamp(true);
        
        // Create size scale for location markers
        const markerSizeScale = d3.scaleSqrt()
            .domain([0, maxLocationSessions])
            .range([3, 15]); // radius in pixels
        
        // Create tooltip
        const tooltip = d3.select('body').append('div')
            .attr('class', 'map-tooltip')
            .style('position', 'absolute')
            .style('background', 'rgba(0, 0, 0, 0.8)')
            .style('color', '#fff')
            .style('padding', '8px 12px')
            .style('border-radius', '4px')
            .style('font-size', '14px')
            .style('pointer-events', 'none')
            .style('opacity', 0)
            .style('z-index', 1000);
        
        // Match countries to features and calculate per-feature session totals
        // Process in two passes: first match named countries, then "Unknown"
        const featureCountryMap = new Map(); // feature -> backend country name
        const featureSessionTotal = new Map(); // feature -> total sessions in that feature
        const countryFeatureMap = new Map(); // country name -> feature (reverse lookup)
        
        // First pass: Match all named countries (not "Unknown")
        allLocations.filter(loc => loc.country !== "Unknown").forEach(loc => {
            // Skip if we already found a feature for this country
            if (countryFeatureMap.has(loc.country)) {
                return;
            }
            
            for (const feature of worldCountries.features) {
                if (d3.geoContains(feature, [loc.lon, loc.lat])) {
                    // Only set if this feature hasn't been claimed by another country
                    if (!featureCountryMap.has(feature)) {
                        featureCountryMap.set(feature, loc.country);
                        countryFeatureMap.set(loc.country, feature);
                        console.log(`Matched ${loc.country} to feature ${feature.properties.name}`);
                    }
                    break;
                }
            }
        });
        
        // Second pass: Match "Unknown" locations to any remaining unclaimed features
        allLocations.filter(loc => loc.country === "Unknown").forEach(loc => {
            for (const feature of worldCountries.features) {
                if (d3.geoContains(feature, [loc.lon, loc.lat])) {
                    // Only set if this feature hasn't been claimed
                    if (!featureCountryMap.has(feature)) {
                        featureCountryMap.set(feature, loc.country);
                        console.log(`Matched Unknown location to feature ${feature.properties.name}`);
                        break; // Only match one Unknown location per feature
                    }
                    break;
                }
            }
        });
        
        // Calculate actual session totals per feature by summing locations within each feature
        worldCountries.features.forEach(feature => {
            let total = 0;
            allLocations.forEach(loc => {
                if (d3.geoContains(feature, [loc.lon, loc.lat])) {
                    total += loc.sessions;
                }
            });
            if (total > 0) {
                featureSessionTotal.set(feature, total);
            }
        });
        
        console.log('Matched country features:', featureCountryMap.size);
        
        // Draw countries (colored by total sessions)
        mapGroup.append('g')
            .selectAll('path')
            .data(worldCountries.features)
            .enter()
            .append('path')
            .attr('d', path)
            .attr('class', 'country')
            .style('fill', d => {
                const sessions = featureSessionTotal.get(d);
                if (sessions) {
                    return countryColorScale(sessions);
                }
                return '#2d3748'; // Dark gray for countries with no data
            })
            .style('stroke', '#4a5568')
            .style('stroke-width', '0.5')
            .style('cursor', 'pointer')
            .on('mouseover', function(event, d) {
                // Prefer D3's country name from map data
                const d3CountryName = d.properties.name;
                const backendCountryName = featureCountryMap.get(d);
                const displayName = d3CountryName || backendCountryName || 'Unknown';
                
                // Get actual sessions within this feature
                const sessions = featureSessionTotal.get(d);
                
                d3.select(this)
                    .style('stroke', '#fff')
                    .style('stroke-width', '2');
                
                tooltip.transition()
                    .duration(200)
                    .style('opacity', 1);
                    
                if (sessions) {
                    tooltip.html(`<strong>${displayName}</strong><br/>Sessions: ${sessions.toLocaleString()}`)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 28) + 'px');
                } else {
                    tooltip.html(`<strong>${displayName}</strong><br/>No session data`)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 28) + 'px');
                }
            })
            .on('mouseout', function() {
                d3.select(this)
                    .style('stroke', '#4a5568')
                    .style('stroke-width', '0.5');
                
                tooltip.transition()
                    .duration(500)
                    .style('opacity', 0);
           });
       
       // Draw location markers (circles)
       mapGroup.append('g')
            .selectAll('circle')
            .data(allLocations)
            .enter()
            .append('circle')
            .attr('cx', d => projection([d.lon, d.lat])[0])
            .attr('cy', d => projection([d.lon, d.lat])[1])
            .attr('r', d => markerSizeScale(d.sessions))
            .style('fill', 'rgba(255, 99, 132, 0.7)')
            .style('stroke', '#fff')
            .style('stroke-width', '1')
            .style('cursor', 'pointer')
            .on('mouseover', function(event, d) {
                d3.select(this)
                    .style('fill', 'rgba(255, 99, 132, 1)')
                    .style('stroke-width', '2');
                
                tooltip.transition()
                    .duration(200)
                    .style('opacity', 1);
                tooltip.html(`<strong>${d.country}</strong><br/>Location Sessions: ${d.sessions.toLocaleString()}<br/>Lat: ${d.lat.toFixed(2)}, Lon: ${d.lon.toFixed(2)}`)
                    .style('left', (event.pageX + 10) + 'px')
                    .style('top', (event.pageY - 28) + 'px');
            })
            .on('mouseout', function(event, d) {
                d3.select(this)
                    .style('fill', 'rgba(255, 99, 132, 0.7)')
                    .style('stroke-width', '1');
                
                tooltip.transition()
                    .duration(500)
                    .style('opacity', 0);
            });
        
        // Add receiver marker if location is available (after listener markers so it's on top)
        if (receiverLocation) {
            const receiverGroup = mapGroup.append('g')
                .attr('class', 'receiver-marker');
            
            // Draw receiver marker (green circle with white border)
            receiverGroup.append('circle')
                .attr('cx', projection([receiverLocation.lon, receiverLocation.lat])[0])
                .attr('cy', projection([receiverLocation.lon, receiverLocation.lat])[1])
                .attr('r', 8)
                .style('fill', '#4CAF50')
                .style('stroke', '#fff')
                .style('stroke-width', '2')
                .style('cursor', 'pointer')
                .on('mouseover', function(event) {
                    d3.select(this)
                        .style('fill', '#45a049')
                        .style('stroke-width', '3');
                    
                    let tooltipContent = '<strong>Receiver Location</strong><br/>';
                    if (receiverInfo) {
                        if (receiverInfo.name) {
                            tooltipContent += `Name: ${receiverInfo.name}<br/>`;
                        }
                        if (receiverInfo.location) {
                            tooltipContent += `Location: ${receiverInfo.location}<br/>`;
                        }
                        if (receiverInfo.callsign) {
                            tooltipContent += `Callsign: ${receiverInfo.callsign}<br/>`;
                        }
                    }
                    tooltipContent += `Coordinates: ${receiverLocation.lat.toFixed(4)}, ${receiverLocation.lon.toFixed(4)}`;
                    
                    tooltip.transition()
                        .duration(200)
                        .style('opacity', 1);
                    tooltip.html(tooltipContent)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 28) + 'px');
                })
                .on('mouseout', function() {
                    d3.select(this)
                        .style('fill', '#4CAF50')
                        .style('stroke-width', '2');
                    
                    tooltip.transition()
                        .duration(500)
                        .style('opacity', 0);
                });
        }
        
        // Add reset zoom button
        svg.append('rect')
            .attr('x', width - 80)
            .attr('y', 10)
            .attr('width', 70)
            .attr('height', 30)
            .attr('rx', 4)
            .style('fill', 'rgba(255, 255, 255, 0.2)')
            .style('stroke', '#fff')
            .style('stroke-width', '1')
            .style('cursor', 'pointer')
            .on('click', function() {
                svg.transition()
                    .duration(750)
                    .call(zoom.transform, d3.zoomIdentity);
            });
        
        svg.append('text')
            .attr('x', width - 45)
            .attr('y', 30)
            .attr('text-anchor', 'middle')
            .style('fill', '#fff')
            .style('font-size', '12px')
            .style('pointer-events', 'none')
            .text('Reset Zoom');
        
        // Add legend for countries (fixed position, not zoomed)
        const legendWidth = 250;
        const legendHeight = 10;
        const legendX = 20;
        const legendY = height - 40;
        
        const legendScale = d3.scaleLinear()
            .domain([0, maxCountrySessions])
            .range([0, legendWidth]);
        
        const legendAxis = d3.axisBottom(legendScale)
            .ticks(5)
            .tickFormat(d => d.toLocaleString());
        
        // Create gradient for legend
        const defs = svg.append('defs');
        const gradient = defs.append('linearGradient')
            .attr('id', 'legend-gradient');
        
        // Add color stops
        for (let i = 0; i <= 10; i++) {
            gradient.append('stop')
                .attr('offset', `${i * 10}%`)
                .attr('stop-color', countryColorScale(maxCountrySessions * i / 10));
        }
        
        // Draw country legend
        const legend = svg.append('g')
            .attr('transform', `translate(${legendX}, ${legendY})`);
        
        legend.append('rect')
            .attr('width', legendWidth)
            .attr('height', legendHeight)
            .style('fill', 'url(#legend-gradient)');
        
        legend.append('g')
            .attr('transform', `translate(0, ${legendHeight})`)
            .call(legendAxis)
            .selectAll('text')
            .style('fill', '#fff')
            .style('font-size', '11px');
        
        legend.selectAll('line, path')
            .style('stroke', '#fff');
        
        legend.append('text')
            .attr('x', legendWidth / 2)
            .attr('y', -5)
            .attr('text-anchor', 'middle')
            .style('fill', '#fff')
            .style('font-size', '12px')
            .text('Total Sessions per Country');
        
        // Add marker legend
        const markerLegendX = width - 180;
        const markerLegendY = height - 130; // Increased space for more items
        
        const markerLegend = svg.append('g')
            .attr('transform', `translate(${markerLegendX}, ${markerLegendY})`);
        
        markerLegend.append('text')
            .attr('x', 0)
            .attr('y', 0)
            .style('fill', '#fff')
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .text('Markers');
        
        let markerLegendYPos = 20;
        
        // Add receiver marker to legend if available
        if (receiverLocation) {
            markerLegend.append('circle')
                .attr('cx', 10)
                .attr('cy', markerLegendYPos)
                .attr('r', 8)
                .style('fill', '#4CAF50')
                .style('stroke', '#fff')
                .style('stroke-width', '2');
            
            markerLegend.append('text')
                .attr('x', 25)
                .attr('y', markerLegendYPos + 4)
                .style('fill', '#fff')
                .style('font-size', '11px')
                .text('Receiver');
            
            markerLegendYPos += 25;
        }
        
        // Show 3 example marker sizes for listener locations
        const exampleSizes = [
            { sessions: Math.ceil(maxLocationSessions * 0.2), label: 'Low' },
            { sessions: Math.ceil(maxLocationSessions * 0.6), label: 'Medium' },
            { sessions: maxLocationSessions, label: 'High' }
        ];
        
        exampleSizes.forEach((example, i) => {
            const y = markerLegendYPos + i * 25;
            markerLegend.append('circle')
                .attr('cx', 10)
                .attr('cy', y)
                .attr('r', markerSizeScale(example.sessions))
                .style('fill', 'rgba(255, 99, 132, 0.7)')
                .style('stroke', '#fff')
                .style('stroke-width', '1');
            
            markerLegend.append('text')
                .attr('x', 25)
                .attr('y', y + 4)
                .style('fill', '#fff')
                .style('font-size', '11px')
                .text(`${example.label}: ${example.sessions.toLocaleString()}`);
        });
        
    } catch (error) {
        console.error('Error creating world map:', error);
    }
}

// Create countries bar chart (top 10)
function createCountriesChart(countries) {
    const ctx = document.getElementById('countriesChart').getContext('2d');
    
    // Take top 10 countries
    const top10 = countries.slice(0, 10);
    
    // Generate colors for each country
    const colors = generateColors(top10.length);
    
    if (countriesChart) {
        countriesChart.destroy();
    }
    
    countriesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: top10.map(c => {
                // Show country name with flag emoji if we have country code
                const flag = c.country_code ? getFlagEmoji(c.country_code) : '🌍';
                return `${flag} ${c.country}`;
            }),
            datasets: [{
                label: 'Sessions',
                data: top10.map(c => c.sessions),
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Sessions: ${context.parsed.y.toLocaleString()}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                x: {
                    ticks: {
                        color: '#fff',
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Create duration buckets pie chart
function createDurationChart(buckets) {
    const ctx = document.getElementById('durationChart').getContext('2d');
    
    // Take top 5 buckets by count
    const top5 = buckets.slice(0, 5);
    
    if (durationChart) {
        durationChart.destroy();
    }
    
    durationChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: top5.map(b => b.range),
            datasets: [{
                label: 'Sessions',
                data: top5.map(b => b.count),
                backgroundColor: [
                    'rgba(255, 99, 132, 0.7)',
                    'rgba(54, 162, 235, 0.7)',
                    'rgba(255, 206, 86, 0.7)',
                    'rgba(75, 192, 192, 0.7)',
                    'rgba(153, 102, 255, 0.7)'
                ],
                borderColor: [
                    'rgba(255, 99, 132, 1)',
                    'rgba(54, 162, 235, 1)',
                    'rgba(255, 206, 86, 1)',
                    'rgba(75, 192, 192, 1)',
                    'rgba(153, 102, 255, 1)'
                ],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#fff',
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${label}: ${value.toLocaleString()} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// Create browsers bar chart
function createBrowsersChart(browsers) {
    const ctx = document.getElementById('browsersChart').getContext('2d');
    
    if (browsersChart) {
        browsersChart.destroy();
    }
    
    // Generate colors for each browser
    const colors = generateColors(browsers.length);
    
    browsersChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: browsers.map(b => b.name),
            datasets: [{
                label: 'Sessions',
                data: browsers.map(b => b.sessions),
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Sessions: ${context.parsed.y.toLocaleString()}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                x: {
                    ticks: {
                        color: '#fff',
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Create operating systems bar chart
function createOSChart(operatingSystems) {
    const ctx = document.getElementById('osChart').getContext('2d');
    
    if (osChart) {
        osChart.destroy();
    }
    
    // Generate colors for each OS
    const colors = generateColors(operatingSystems.length);
    
    osChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: operatingSystems.map(os => os.name),
            datasets: [{
                label: 'Sessions',
                data: operatingSystems.map(os => os.sessions),
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Sessions: ${context.parsed.y.toLocaleString()}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                x: {
                    ticks: {
                        color: '#fff',
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Create weekday activity bar chart
function createWeekdayChart(weekdayData) {
    const ctx = document.getElementById('weekdayChart').getContext('2d');
    
    // Weekday labels (Sunday=0 to Saturday=6)
    const weekdayLabels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    if (weekdayChart) {
        weekdayChart.destroy();
    }
    
    weekdayChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: weekdayLabels,
            datasets: [{
                label: 'Avg Sessions per Day',
                data: weekdayData,
                backgroundColor: [
                    'rgba(255, 99, 132, 0.7)',
                    'rgba(54, 162, 235, 0.7)',
                    'rgba(255, 206, 86, 0.7)',
                    'rgba(75, 192, 192, 0.7)',
                    'rgba(153, 102, 255, 0.7)',
                    'rgba(255, 159, 64, 0.7)',
                    'rgba(201, 203, 207, 0.7)'
                ],
                borderColor: [
                    'rgba(255, 99, 132, 1)',
                    'rgba(54, 162, 235, 1)',
                    'rgba(255, 206, 86, 1)',
                    'rgba(75, 192, 192, 1)',
                    'rgba(153, 102, 255, 1)',
                    'rgba(255, 159, 64, 1)',
                    'rgba(201, 203, 207, 1)'
                ],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Avg: ${context.parsed.y.toFixed(2)} sessions`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toFixed(1);
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    title: {
                        display: true,
                        text: 'Average Sessions',
                        color: '#fff',
                        font: {
                            size: 12
                        }
                    }
                },
                x: {
                    ticks: {
                        color: '#fff'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Create hourly activity line chart
function createHourlyChart(hourlyData) {
    const ctx = document.getElementById('hourlyChart').getContext('2d');
    
    // Create labels for 24 hours (00:00 to 23:00)
    const labels = Array.from({length: 24}, (_, i) => {
        return `${i.toString().padStart(2, '0')}:00`;
    });
    
    if (hourlyChart) {
        hourlyChart.destroy();
    }
    
    hourlyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Avg Sessions per Hour',
                data: hourlyData,
                borderColor: 'rgba(75, 192, 192, 1)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: 'rgba(75, 192, 192, 1)',
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#fff',
                        font: {
                            size: 14
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Avg: ${context.parsed.y.toFixed(2)} sessions`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toFixed(1);
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    title: {
                        display: true,
                        text: 'Average Sessions',
                        color: '#fff',
                        font: {
                            size: 12
                        }
                    }
                },
                x: {
                    ticks: {
                        color: '#fff',
                        maxRotation: 45,
                        minRotation: 45
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    title: {
                        display: true,
                        text: 'Hour (UTC)',
                        color: '#fff',
                        font: {
                            size: 12
                        }
                    }
                }
            }
        }
    });
}

// Create bands donut chart
function createBandsChart(bands) {
    const ctx = document.getElementById('bandsChart').getContext('2d');
    
    if (bandsChart) {
        bandsChart.destroy();
    }
    
    // Generate colors for each band
    const colors = generateColors(bands.length);
    
    bandsChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: bands.map(b => b.name),
            datasets: [{
                label: 'Sessions',
                data: bands.map(b => b.sessions),
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#fff',
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${label}: ${value.toLocaleString()} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// Create modes horizontal bar chart
function createModesChart(modes) {
    const ctx = document.getElementById('modesChart').getContext('2d');
    
    if (modesChart) {
        modesChart.destroy();
    }
    
    // Generate colors for each mode
    const colors = generateColors(modes.length);
    
    modesChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: modes.map(m => m.name.toUpperCase()),
            datasets: [{
                label: 'Sessions',
                data: modes.map(m => m.sessions),
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            indexAxis: 'y', // This makes it horizontal
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `Sessions: ${context.parsed.x.toLocaleString()}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    ticks: {
                        color: '#fff'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        }
    });
}

// Generate colors for charts
function generateColors(count) {
    const colors = [];
    const hueStep = 360 / count;
    
    for (let i = 0; i < count; i++) {
        const hue = i * hueStep;
        colors.push(`hsla(${hue}, 70%, 60%, 0.7)`);
    }
    
    return colors;
}

// Get flag emoji from country code
function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) {
        return '🌍';
    }
    
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt());
    
    return String.fromCodePoint(...codePoints);
}

// Load statistics on page load
document.addEventListener('DOMContentLoaded', loadStatistics);
