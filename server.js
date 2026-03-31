const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const SERP_API_KEY = '438bb534281f343dfca13eac6fd343368b2a42d168c76c77ff8c047eeafa9ed5';

app.get('/search', async (req, res) => {
  const { niche, city, count = 25 } = req.query;

  if (!niche || !city) {
    return res.status(400).json({ error: 'niche and city are required' });
  }

  try {
    let allResults = [];
    let nextPageToken = null;
    const maxResults = Math.min(parseInt(count), 100);

    // SerpAPI Google Maps returns 20 per page — paginate using 'start'
    const pages = Math.ceil(maxResults / 20);
    for (let page = 0; page < pages && allResults.length < maxResults; page++) {
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
        break; // no more results available
      }
    }

    // Format results
    const leads = allResults.slice(0, maxResults).map((biz, i) => {
      const hasWebsite = !!biz.website;
      const rating = biz.rating || null;
      const reviews = biz.reviews || 0;
      const hasPhone = !!biz.phone;

      // Calculate lead score
      let score = 50;
      if (!hasWebsite) score += 20;
      if (reviews < 10) score += 15;
      if (rating && rating < 4.0) score += 10;
      if (!biz.thumbnail) score += 5;
      score = Math.min(score, 99);

      // AI score explanation
      const reasons = [];
      if (!hasWebsite) reasons.push('no website');
      if (reviews < 10) reasons.push(`only ${reviews} reviews`);
      if (rating && rating < 4.0) reasons.push(`low rating (${rating})`);
      const explanation = reasons.length
        ? reasons.join(' + ') + ' = high opportunity'
        : 'established business';

      return {
        id: i + 1,
        name: biz.title || 'Unknown Business',
        address: biz.address || 'Address not available',
        phone: biz.phone || null,
        website: biz.website || null,
        hasWebsite,
        rating: rating,
        reviews: reviews,
        category: biz.type || niche,
        score,
        scoreExplanation: explanation,
        email: null, // email finder coming soon
        ownerName: null, // owner lookup coming soon
        social: {
          facebook: null,
          instagram: null,
        },
        verified: new Date().toISOString().split('T')[0],
      };
    });

    res.json({
      success: true,
      query: { niche, city, count: maxResults },
      total: leads.length,
      leads,
    });

  } catch (err) {
    console.error('SerpAPI error:', err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadHunter backend running on port ${PORT}`));
