const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Force CORS headers on every response including errors
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const SERP_API_KEY = '438bb534281f343dfca13eac6fd343368b2a42d168c76c77ff8c047eeafa9ed5';

// Admin Supabase client (service role — never expose this to frontend)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Plan limits
const PLAN_LIMITS = {
  free:  { searches: 5,         maxLeads: 25  },
  pro:   { searches: Infinity,  maxLeads: 100 },
};


// Scrape email and founding year from a business website in one pass
async function scrapeWebsiteData(websiteUrl) {
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const emailIgnore = /\.(png|jpg|jpeg|gif|svg|webp|css|js)@|noreply|no-reply|@example\.|@sentry\.|@wix|@squarespace|@shopify|@wordpress|@gravatar|privacy@|support@apple|amazonaws/i;
  const currentYear = new Date().getFullYear();

  const base = websiteUrl.replace(/\/$/, '');
  const pagesToTry = [base, `${base}/contact`];

  let email = null;
  let foundingYear = null;
  const result = { email: null, foundingYear: null, hasBooking: false };

  for (const page of pagesToTry) {
    try {
      const res = await axios.get(page, {
        timeout: 2500,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        maxRedirects: 2,
        maxContentLength: 200000,
      });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // Email
      if (!email) {
        const found = (html.match(emailRegex) || []).filter(e => !emailIgnore.test(e));
        if (found.length) email = found[0].toLowerCase();
      }

      // Booking tool detection (only need homepage)
      if (page === base) {
        result.hasBooking = /calendly\.com|acuityscheduling\.com|booksy\.com|squareup\.com\/appointments|mindbodyonline\.com|vagaro\.com|opentable\.com|setmore\.com|simplybook\.me|fresha\.com|zocdoc\.com|10to8\.com|appointy\.com|book\.app|resy\.com|bookingkoala\.com|gettimely\.com/i.test(html);
      }

      // Founding year — JSON-LD schema first
      if (!foundingYear) {
        const jsonLdBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of jsonLdBlocks) {
          try {
            const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/gi, ''));
            const schemas = Array.isArray(json) ? json : [json];
            for (const schema of schemas) {
              const fd = schema.foundingDate || schema.foundedDate;
              if (fd) {
                const yr = parseInt(String(fd).slice(0, 4));
                if (yr >= 1900 && yr <= currentYear) { foundingYear = yr; break; }
              }
            }
          } catch (_) {}
        }
      }

      // Founding year — text patterns
      if (!foundingYear) {
        const patterns = [
          /(?:est(?:ablished)?\.?|founded|since|serving since|in business since|trading since)[^\d]{0,10}(\d{4})/i,
          /©\s*(\d{4})\s*[-–]\s*\d{4}/,  // © 2008-2024
        ];
        for (const pat of patterns) {
          const m = html.match(pat);
          if (m) {
            const yr = parseInt(m[1]);
            if (yr >= 1900 && yr <= currentYear) { foundingYear = yr; break; }
          }
        }
      }

      result.email = email;
      result.foundingYear = foundingYear;
      if (email && result.hasGoogleAds !== undefined) break;
    } catch (_) {}
  }

  result.email = email;
  result.foundingYear = foundingYear;
  return result;
}

// Get start of current month
function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// Middleware to verify Supabase JWT and load user profile
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }

  const token = authHeader.replace('Bearer ', '');

  // Verify token and get user
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }

  // Load profile
  let { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  // Create profile if it doesn't exist yet
  if (!profile) {
    const { data: newProfile } = await supabaseAdmin
      .from('profiles')
      .insert({ id: user.id, plan: 'free', searches_used: 0 })
      .select()
      .single();
    profile = newProfile;
  }

  // Reset monthly count if new month
  if (!profile.searches_reset_date || new Date(profile.searches_reset_date) < new Date(monthStart())) {
    await supabaseAdmin
      .from('profiles')
      .update({ searches_used: 0, searches_reset_date: new Date().toISOString() })
      .eq('id', user.id);
    profile.searches_used = 0;
  }

  req.user    = user;
  req.profile = profile;
  next();
}

app.get('/search', requireAuth, async (req, res) => {
  const { niche, city, count } = req.query;
  const { profile } = req;

  if (!niche || !city) {
    return res.status(400).json({ error: 'niche and city are required' });
  }

  const plan   = profile.plan || 'free';
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  // Check monthly search limit
  if (limits.searches !== Infinity && profile.searches_used >= limits.searches) {
    return res.status(403).json({
      error: 'LIMIT_REACHED',
      message: `You've used all ${limits.searches} free searches this month. Upgrade to Pro for unlimited searches.`,
      searches_used: profile.searches_used,
      plan,
    });
  }

  // Cap lead count to plan limit
  const requestedCount = Math.min(parseInt(count) || 25, limits.maxLeads);

  try {
    let allResults = [];
    const pages = Math.ceil(requestedCount / 20);

    for (let page = 0; page < pages && allResults.length < requestedCount; page++) {
      const params = {
        engine: 'google_maps',
        q: `${niche} in ${city}`,
        type: 'search',
        api_key: SERP_API_KEY,
        hl: 'en',
        start: page * 20,
      };

      const response = await axios.get('https://serpapi.com/search', { params });
      const data = response.data;

      if (data.local_results && data.local_results.length > 0) {
        allResults = allResults.concat(data.local_results);
      } else {
        break;
      }
    }

    // Format results
    const leads = allResults.slice(0, requestedCount).map((biz, i) => {
      const hasWebsite = !!biz.website;
      const rating  = biz.rating || null;
      const reviews = biz.reviews || 0;
      const hasPhone = !!biz.phone;

      // Score calculation — higher = more opportunity (weaker online presence)
      let score = 30;

      // Website — biggest signal
      if (!hasWebsite)                    score += 35;

      // Reviews
      if (reviews === 0)                  score += 25;
      else if (reviews < 5)               score += 20;
      else if (reviews < 15)              score += 12;
      else if (reviews < 30)              score += 5;
      else if (reviews >= 100)            score -= 10; // very established

      // Rating
      if (!rating)                        score += 5;
      else if (rating < 3.0)              score += 20;
      else if (rating < 3.5)              score += 14;
      else if (rating < 4.0)              score += 8;
      else if (rating >= 4.5 && reviews >= 50) score -= 8; // popular & well-rated

      // Profile gaps
      if (!biz.thumbnail)                 score += 7;
      if (!biz.phone)                     score += 5;

      score = Math.max(10, Math.min(99, score));

      // Score label
      const scoreLabel = score >= 75 ? 'Hot Lead' : score >= 50 ? 'Warm Lead' : 'Cold Lead';

      // Detailed gaps for AI explanation
      const gaps = [];
      if (!hasWebsite)                gaps.push('No website');
      if (reviews === 0)              gaps.push('Zero reviews');
      else if (reviews < 10)          gaps.push(`Only ${reviews} reviews`);
      if (rating && rating < 3.0)     gaps.push(`Poor rating (${rating}★)`);
      else if (rating && rating < 4.0) gaps.push(`Below-average rating (${rating}★)`);
      if (!hasPhone)                  gaps.push('No phone listed');
      if (!biz.thumbnail)             gaps.push('No profile photo');

      const scoreExplanation = gaps.length
        ? gaps.join(' · ') + ` → ${scoreLabel}`
        : `Strong online presence → ${scoreLabel}`;

      return {
        id: i + 1,
        name:             biz.title || 'Unknown Business',
        address:          biz.address || 'Address not available',
        phone:            biz.phone || null,
        website:          biz.website || null,
        hasWebsite,
        rating,
        reviews,
        category:         biz.type || niche,
        score,
        scoreLabel,
        scoreExplanation,
        gaps,
        email:            null,
        emailProbable:    false,
        hasBooking:       false,
        ownerName:        null,
        social:           { facebook: null, instagram: null },
        verified:         new Date().toISOString().split('T')[0],
      };
    });

    // Scrape email + founding year from websites in parallel
    const scrapeResults = await Promise.allSettled(
      leads.map(l => l.website ? scrapeWebsiteData(l.website) : Promise.resolve({}))
    );
    const currentYear = new Date().getFullYear();
    scrapeResults.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value) {
        const { email, hasBooking } = result.value;
        if (email) leads[i].email = email;
        leads[i].hasBooking = hasBooking || false;
      }
    });

    // Increment search count
    await supabaseAdmin
      .from('profiles')
      .update({ searches_used: (profile.searches_used || 0) + 1 })
      .eq('id', req.user.id);

    res.json({
      success: true,
      query: { niche, city, count: requestedCount },
      total: leads.length,
      leads,
      usage: {
        plan,
        searches_used: (profile.searches_used || 0) + 1,
        searches_limit: limits.searches === Infinity ? 'unlimited' : limits.searches,
        leads_limit: limits.maxLeads,
      },
    });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadHunter backend running on port ${PORT}`));
