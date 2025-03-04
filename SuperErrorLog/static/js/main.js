/**
 * 超级错题本 - 主JavaScript文件
 */

// 在DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 添加Bootstrap图标支持
    addBootstrapIcons();
    
    // 初始化工具提示
    initTooltips();
    
    // 处理移动端导航栏折叠
    handleMobileNav();
    
    // 初始化滚动动画
    initScrollAnimations();
    
    // 初始化计数器动画
    initCounterAnimations();
    
    // 处理闪现消息自动关闭
    handleAlertDismiss();
    
    // 处理价格切换
    handlePricingToggle();
});

/**
 * 添加Bootstrap图标支持
 */
function addBootstrapIcons() {
    // 检查是否已加载Bootstrap图标
    if (!document.querySelector('link[href*="bootstrap-icons"]')) {
        const iconLink = document.createElement('link');
        iconLink.rel = 'stylesheet';
        iconLink.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css';
        document.head.appendChild(iconLink);
    }
    
    // 替换上传图标
    const uploadIcons = document.querySelectorAll('.upload-icon i');
    uploadIcons.forEach(icon => {
        if (icon.classList.contains('bi-cloud-arrow-up')) {
            icon.outerHTML = '<i class="bi bi-cloud-arrow-up"></i>';
        }
    });
}

/**
 * 初始化Bootstrap工具提示
 */
function initTooltips() {
    // 检查是否存在工具提示元素
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    if (tooltipTriggerList.length > 0) {
        tooltipTriggerList.map(function(tooltipTriggerEl) {
            return new bootstrap.Tooltip(tooltipTriggerEl);
        });
    }
}

/**
 * 处理移动端导航栏折叠
 */
function handleMobileNav() {
    const navbarToggler = document.querySelector('.navbar-toggler');
    const navbarCollapse = document.querySelector('.navbar-collapse');
    
    if (navbarToggler && navbarCollapse) {
        // 点击导航项后自动折叠导航栏
        const navItems = navbarCollapse.querySelectorAll('.nav-link, .dropdown-item');
        navItems.forEach(item => {
            item.addEventListener('click', function() {
                if (window.innerWidth < 992) {  // Bootstrap lg断点
                    navbarCollapse.classList.remove('show');
                }
            });
        });
    }
    
    // 滚动时导航栏阴影效果
    window.addEventListener('scroll', function() {
        const navbar = document.querySelector('.navbar');
        if (navbar) {
            if (window.scrollY > 10) {
                navbar.classList.add('shadow-sm');
            } else {
                navbar.classList.remove('shadow-sm');
            }
        }
    });
}

/**
 * 初始化滚动动画
 */
function initScrollAnimations() {
    const animatedElements = document.querySelectorAll('.fade-in');
    
    if (animatedElements.length > 0) {
        // 检查元素是否在视口中
        function checkInView() {
            animatedElements.forEach(element => {
                const rect = element.getBoundingClientRect();
                const windowHeight = window.innerHeight || document.documentElement.clientHeight;
                
                if (rect.top <= windowHeight * 0.8) {
                    element.style.opacity = '1';
                    element.style.transform = 'translateY(0)';
                }
            });
        }
        
        // 初始化样式
        animatedElements.forEach(element => {
            element.style.opacity = '0';
            element.style.transform = 'translateY(20px)';
            element.style.transition = 'opacity 0.8s ease, transform 0.8s ease';
        });
        
        // 首次检查
        checkInView();
        
        // 滚动时检查
        window.addEventListener('scroll', checkInView);
    }
}

/**
 * 初始化计数器动画
 */
function initCounterAnimations() {
    const counters = document.querySelectorAll('.display-4.fw-bold.text-primary');
    
    if (counters.length > 0) {
        // 检查元素是否在视口中
        function checkInView() {
            counters.forEach(counter => {
                if (counter.dataset.counted) return;
                
                const rect = counter.getBoundingClientRect();
                const windowHeight = window.innerHeight || document.documentElement.clientHeight;
                
                if (rect.top <= windowHeight * 0.8) {
                    const target = counter.innerText;
                    const isPlus = target.includes('+');
                    const numTarget = parseInt(target.replace(/,|\+/g, ''));
                    let count = 0;
                    const duration = 2000; // 2秒
                    const interval = Math.max(10, duration / numTarget);
                    const step = Math.ceil(numTarget / (duration / interval));
                    
                    counter.innerText = '0';
                    counter.dataset.counted = 'true';
                    
                    const timer = setInterval(() => {
                        count += step;
                        if (count >= numTarget) {
                            clearInterval(timer);
                            counter.innerText = isPlus ? numTarget.toLocaleString() + '+' : numTarget.toLocaleString();
                        } else {
                            counter.innerText = isPlus ? count.toLocaleString() + '+' : count.toLocaleString();
                        }
                    }, interval);
                }
            });
        }
        
        // 首次检查
        checkInView();
        
        // 滚动时检查
        window.addEventListener('scroll', checkInView);
    }
}

/**
 * 处理闪现消息自动关闭
 */
function handleAlertDismiss() {
    const alerts = document.querySelectorAll('.alert');
    
    alerts.forEach(alert => {
        // 5秒后自动关闭
        setTimeout(() => {
            const closeBtn = alert.querySelector('.btn-close');
            if (closeBtn) {
                closeBtn.click();
            }
        }, 5000);
    });
}

/**
 * 处理价格切换
 */
function handlePricingToggle() {
    const monthlyRadio = document.getElementById('monthly');
    const yearlyRadio = document.getElementById('yearly');
    
    if (monthlyRadio && yearlyRadio) {
        const monthlyPrices = document.querySelectorAll('.monthly-price');
        const yearlyPrices = document.querySelectorAll('.yearly-price');
        
        monthlyRadio.addEventListener('change', function() {
            if (this.checked) {
                monthlyPrices.forEach(el => el.style.display = 'block');
                yearlyPrices.forEach(el => el.style.display = 'none');
            }
        });
        
        yearlyRadio.addEventListener('change', function() {
            if (this.checked) {
                monthlyPrices.forEach(el => el.style.display = 'none');
                yearlyPrices.forEach(el => el.style.display = 'block');
            }
        });
    }
}

/**
 * 格式化日期时间
 * @param {string|Date} dateTime - 日期时间字符串或Date对象
 * @param {boolean} includeTime - 是否包含时间
 * @returns {string} 格式化后的日期时间字符串
 */
function formatDateTime(dateTime, includeTime = true) {
    if (!dateTime) return '';
    
    const date = typeof dateTime === 'string' ? new Date(dateTime) : dateTime;
    
    if (isNaN(date.getTime())) return dateTime;  // 如果无效日期则返回原值
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    if (!includeTime) {
        return `${year}-${month}-${day}`;
    }
    
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 截断文本
 * @param {string} text - 原始文本
 * @param {number} length - 最大长度
 * @returns {string} 截断后的文本
 */
function truncateText(text, length = 100) {
    if (!text) return '';
    if (text.length <= length) return text;
    return text.substring(0, length) + '...';
}

/**
 * 显示加载中动画
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 显示消息
 */
function showLoading(container, message = '加载中...') {
    container.innerHTML = `
        <div class="loading-container">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">加载中...</span>
            </div>
            <p class="mt-3">${message}</p>
        </div>
    `;
}

/**
 * 显示错误消息
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 错误消息
 */
function showError(container, message = '发生错误，请重试') {
    container.innerHTML = `
        <div class="error-state">
            <i class="bi bi-exclamation-triangle-fill error-state-icon"></i>
            <p class="mt-3 text-danger">${message}</p>
            <button class="btn btn-outline-primary mt-3" onclick="window.location.reload()">
                <i class="bi bi-arrow-clockwise me-2"></i>重试
            </button>
        </div>
    `;
}

/**
 * 显示空数据消息
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 显示消息
 */
function showEmptyData(container, message = '暂无数据') {
    container.innerHTML = `
        <div class="empty-state">
            <i class="bi bi-inbox empty-state-icon"></i>
            <p class="mt-3 text-muted">${message}</p>
        </div>
    `;
} 