// Test script that runs in the sandbox
console.log("Script loaded successfully!")

const output = document.getElementById("output")
output.innerHTML = `
    <p>Script executed at: ${new Date().toLocaleTimeString()}</p>
    <p>Location: ${window.location.href}</p>
`

// Test that we're isolated
try {
    const topHref = window.top.location.href
    output.innerHTML += `<p style="color: red;">FAIL: window.top accessible</p>`
} catch (e) {
    output.innerHTML += `<p style="color: lime;">PASS: window.top blocked</p>`
}

// Button handler
const btn = document.getElementById("testBtn")
const clickOutput = document.getElementById("clickOutput")
let clickCount = 0

btn.addEventListener("click", () => {
    clickCount++
    clickOutput.innerHTML = `<p style="color: #a352ff;">Button clicked ${clickCount} time(s)!</p>`
    console.log(`Button clicked: ${clickCount}`)
})
