// Session Statistics Visualization
// Fetches data from /api/session-stats and displays it using Chart.js

let countriesChart = null;
let durationChart = null;
let weekdayChart = null;
let hourlyChart = null;

// Fetch and display statistics
async function loadStatistics() {
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
        createWeekdayChart(data.stats.avg_weekday_activity);
        createHourlyChart(data.stats.avg_hourly_activity);
        
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
        
        // Create a map of country code to session count
        const countryDataMap = {};
        let maxSessions = 0;
        
        countries.forEach(c => {
            if (c.country_code) {
                const code = c.country_code.toUpperCase();
                countryDataMap[code] = c.sessions;
                if (c.sessions > maxSessions) {
                    maxSessions = c.sessions;
                }
            }
        });
        
        console.log('Country data map:', countryDataMap);
        console.log('Max sessions:', maxSessions);
        
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
        
        // Create color scale (blue gradient)
        const colorScale = d3.scaleSequential()
            .domain([0, maxSessions])
            .interpolator(d3.interpolateBlues);
        
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
        
        // Draw countries
        svg.append('g')
            .selectAll('path')
            .data(worldCountries.features)
            .enter()
            .append('path')
            .attr('d', path)
            .attr('class', 'country')
            .style('fill', d => {
                // Try multiple property names for country code
                const code = d.properties.iso_a2 ||
                            d.properties.ISO_A2 ||
                            d.properties.iso_a2_eh ||
                            d.properties.gu_a3 ||
                            d.id;
                
                // Log first few countries for debugging
                if (d.id < 5) {
                    console.log('Country properties:', d.properties);
                }
                
                const sessions = countryDataMap[code];
                
                if (sessions) {
                    return colorScale(sessions);
                }
                return '#2d3748'; // Dark gray for countries with no data
            })
            .style('stroke', '#4a5568')
            .style('stroke-width', '0.5')
            .style('cursor', 'pointer')
            .on('mouseover', function(event, d) {
                const code = d.properties.iso_a2 || d.properties.ISO_A2;
                const sessions = countryDataMap[code];
                const countryName = d.properties.name || 'Unknown';
                
                d3.select(this)
                    .style('stroke', '#fff')
                    .style('stroke-width', '2');
                
                if (sessions) {
                    tooltip.transition()
                        .duration(200)
                        .style('opacity', 1);
                    tooltip.html(`<strong>${countryName}</strong><br/>Sessions: ${sessions.toLocaleString()}`)
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
        
        // Add legend
        const legendWidth = 300;
        const legendHeight = 10;
        const legendX = width - legendWidth - 20;
        const legendY = height - 40;
        
        const legendScale = d3.scaleLinear()
            .domain([0, maxSessions])
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
                .attr('stop-color', colorScale(maxSessions * i / 10));
        }
        
        // Draw legend
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
            .text('Sessions per Country');
        
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
