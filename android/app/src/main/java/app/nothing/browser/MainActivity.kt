package app.nothing.browser

import android.content.Intent
import android.os.Bundle
import android.util.Patterns
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import org.mozilla.geckoview.ContentBlocking
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.GeckoView
import java.net.URLEncoder

class MainActivity : AppCompatActivity() {

    companion object {
        private const val SEARCH_BASE = "https://lite.duckduckgo.com/lite/?q="
        private const val SEARCH_ORIGIN = "https://lite.duckduckgo.com"
        private var runtime: GeckoRuntime? = null
    }

    private lateinit var geckoView: GeckoView
    private lateinit var searchContainer: FrameLayout
    private lateinit var searchBar: EditText
    private lateinit var session: GeckoSession

    private var canGoBack = false
    private var isBrowsing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        geckoView = findViewById(R.id.geckoView)
        searchContainer = findViewById(R.id.searchContainer)
        searchBar = findViewById(R.id.searchBar)

        val geckoRuntime = runtime ?: createPrivacyRuntime().also { runtime = it }

        val sessionSettings = GeckoSessionSettings.Builder()
            .usePrivateMode(true)
            .useTrackingProtection(true)
            .build()

        session = GeckoSession(sessionSettings)
        session.navigationDelegate = object : GeckoSession.NavigationDelegate {
            override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
                this@MainActivity.canGoBack = canGoBack
            }

            override fun onLocationChange(
                session: GeckoSession,
                url: String?,
                perms: MutableList<GeckoSession.PermissionDelegate.ContentPermission>,
                hasUserGesture: Boolean
            ) {
                if (!url.isNullOrBlank() && url != "about:blank" && !searchBar.hasFocus()) {
                    searchBar.setText(url)
                }
            }
        }

        session.open(geckoRuntime)
        geckoView.setSession(session)

        // Pre-warm DNS + TLS socket to search engine so first search opens immediately
        geckoRuntime.warmUp()
        session.speculativeConnect(SEARCH_ORIGIN)

        searchBar.setOnEditorActionListener { _, actionId, event ->
            val isSubmit = actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_SEARCH ||
                actionId == EditorInfo.IME_ACTION_DONE ||
                (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)

            if (isSubmit) {
                submitInput(searchBar.text.toString())
                true
            } else {
                false
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (isBrowsing && canGoBack) {
                    session.goBack()
                } else if (isBrowsing) {
                    returnToNothing()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun createPrivacyRuntime(): GeckoRuntime {
        val contentBlocking = ContentBlocking.Settings.Builder()
            .antiTracking(ContentBlocking.AntiTracking.STRICT)
            .enhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.STRICT)
            .cookieBehavior(ContentBlocking.CookieBehavior.ACCEPT_FIRST_PARTY_AND_ISOLATE_OTHERS)
            .build()

        val settings = GeckoRuntimeSettings.Builder()
            .contentBlocking(contentBlocking)
            .consoleOutput(false)
            .aboutConfigEnabled(false)
            .build()

        return GeckoRuntime.create(applicationContext, settings)
    }

    private fun handleIntent(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (data.startsWith("http://") || data.startsWith("https://")) {
            searchBar.setText(data)
            loadUrl(data)
        }
    }

    private fun submitInput(raw: String) {
        val query = raw.trim()
        if (query.isEmpty()) {
            returnToNothing()
            return
        }

        val targetUrl = if (query.startsWith("http://") || query.startsWith("https://")) {
            query
        } else if (!query.contains(" ") && Patterns.WEB_URL.matcher(query).matches()) {
            "https://$query"
        } else {
            "$SEARCH_BASE${URLEncoder.encode(query, "UTF-8")}"
        }

        loadUrl(targetUrl)
    }

    private fun loadUrl(url: String) {
        isBrowsing = true
        geckoView.visibility = View.VISIBLE
        val params = searchContainer.layoutParams as FrameLayout.LayoutParams
        params.gravity = Gravity.BOTTOM
        searchContainer.layoutParams = params

        searchBar.clearFocus()
        hideKeyboard()
        session.loadUri(url)
    }

    private fun returnToNothing() {
        isBrowsing = false
        canGoBack = false
        session.loadUri("about:blank")
        geckoView.visibility = View.GONE
        searchBar.setText("")

        val params = searchContainer.layoutParams as FrameLayout.LayoutParams
        params.gravity = Gravity.CENTER
        searchContainer.layoutParams = params

        session.speculativeConnect(SEARCH_ORIGIN)
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(searchBar.windowToken, 0)
    }

    override fun onDestroy() {
        session.close()
        super.onDestroy()
    }
}
