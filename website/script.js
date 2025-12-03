// UberSDR Website JavaScript

// Smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Fetch instance statistics from the instances API
async function fetchInstanceStats() {
    const instanceCountEl = document.getElementById('instanceCount');
    const countryCountEl = document.getElementById('countryCount');
    const bandCountEl = document.getElementById('bandCount');

    // Add loading animation
    [instanceCountEl, countryCountEl, bandCountEl].forEach(el => {
        el.classList.add('loading');
    });

    try {
        const response = await fetch('https://instances.ubersdr.org/api/instances');

        if (!response.ok) {
            throw new Error('Failed to fetch instance data');
        }

        const data = await response.json();

        // Calculate statistics
        const instanceCount = data.length || 0;

        // Count unique countries
        const countries = new Set();
        data.forEach(instance => {
            if (instance.country) {
                countries.add(instance.country);
            }
        });
        const countryCount = countries.size;

        // Count unique bands (estimate based on typical SDR coverage)
        // This is a placeholder - adjust based on actual API data structure
        const bandCount = estimateBandCount(data);

        // Animate the numbers
        animateValue(instanceCountEl, 0, instanceCount, 1000);
        animateValue(countryCountEl, 0, countryCount, 1000);
        animateValue(bandCountEl, 0, bandCount, 1000);

    } catch (error) {
        console.error('Error fetching instance stats:', error);

        // Show fallback values
        instanceCountEl.textContent = '10+';
        countryCountEl.textContent = '5+';
        bandCountEl.textContent = '20+';
    } finally {
        // Remove loading animation
        [instanceCountEl, countryCountEl, bandCountEl].forEach(el => {
            el.classList.remove('loading');
        });
    }
}

// Estimate band count based on instance data
function estimateBandCount(instances) {
    // If the API provides band information, use it
    // Otherwise, return a reasonable estimate
    const uniqueBands = new Set();

    instances.forEach(instance => {
        if (instance.bands && Array.isArray(instance.bands)) {
            instance.bands.forEach(band => uniqueBands.add(band));
        }
    });

    // If we found band data, return it; otherwise return estimate
    return uniqueBands.size > 0 ? uniqueBands.size : 20;
}

// Animate number counting
function animateValue(element, start, end, duration) {
    const startTime = performance.now();
    const range = end - start;

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function for smooth animation
        const easeOutQuart = 1 - Math.pow(1 - progress, 4);
        const current = Math.floor(start + range * easeOutQuart);

        element.textContent = current;

        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = end;
        }
    }

    requestAnimationFrame(update);
}

// Add scroll-based animations
function handleScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    // Observe feature cards
    document.querySelectorAll('.feature-card').forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = `all 0.6s ease ${index * 0.1}s`;
        observer.observe(card);
    });

    // Observe steps
    document.querySelectorAll('.step').forEach((step, index) => {
        step.style.opacity = '0';
        step.style.transform = 'translateY(30px)';
        step.style.transition = `all 0.6s ease ${index * 0.15}s`;
        observer.observe(step);
    });
}

// Add parallax effect to hero section
function handleParallax() {
    const hero = document.querySelector('.hero');
    if (!hero) return;

    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const parallaxSpeed = 0.5;
        hero.style.transform = `translateY(${scrolled * parallaxSpeed}px)`;
    });
}

// Handle header background on scroll
function handleHeaderScroll() {
    const header = document.querySelector('header');
    if (!header) return;

    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            header.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.3)';
        } else {
            header.style.boxShadow = 'none';
        }
    });
}

// Add click tracking for external links (optional analytics)
function trackExternalLinks() {
    document.querySelectorAll('a[target="_blank"]').forEach(link => {
        link.addEventListener('click', (e) => {
            const url = e.currentTarget.href;
            console.log('External link clicked:', url);
            // Add analytics tracking here if needed
        });
    });
}

// Initialize all features when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Fetch and display instance statistics
    fetchInstanceStats();

    // Initialize scroll animations
    handleScrollAnimations();

    // Initialize parallax effect
    handleParallax();

    // Initialize header scroll effect
    handleHeaderScroll();

    // Track external links
    trackExternalLinks();

    console.log('UberSDR website initialized');
});

// Handle visibility change to refresh stats when user returns to tab
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // Refresh stats when user returns to the page
        fetchInstanceStats();
    }
});

// Add keyboard navigation support
document.addEventListener('keydown', (e) => {
    // Press 'i' to go to instances section
    if (e.key === 'i' || e.key === 'I') {
        const instancesSection = document.getElementById('instances');
        if (instancesSection) {
            instancesSection.scrollIntoView({ behavior: 'smooth' });
        }
    }

    // Press 'f' to go to features section
    if (e.key === 'f' || e.key === 'F') {
        const featuresSection = document.getElementById('features');
        if (featuresSection) {
            featuresSection.scrollIntoView({ behavior: 'smooth' });
        }
    }
});

// Carousel functionality
let currentSlideIndex = 1;

function moveCarousel(direction) {
    showSlide(currentSlideIndex += direction);
}

function currentSlide(n) {
    showSlide(currentSlideIndex = n);
}

function showSlide(n) {
    const slides = document.querySelectorAll('.carousel-slide');
    const dots = document.querySelectorAll('.dot');

    if (n > slides.length) {
        currentSlideIndex = 1;
    }
    if (n < 1) {
        currentSlideIndex = slides.length;
    }

    // Hide all slides
    slides.forEach(slide => {
        slide.classList.remove('active');
    });

    // Remove active class from all dots
    dots.forEach(dot => {
        dot.classList.remove('active');
    });

    // Show current slide and activate corresponding dot
    if (slides[currentSlideIndex - 1]) {
        slides[currentSlideIndex - 1].classList.add('active');
    }
    if (dots[currentSlideIndex - 1]) {
        dots[currentSlideIndex - 1].classList.add('active');
    }
}

// Export functions for potential use in other scripts
window.UberSDR = {
    fetchInstanceStats,
    animateValue
};

// Make carousel functions globally available
window.moveCarousel = moveCarousel;
window.currentSlide = currentSlide;