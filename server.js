require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require("@google/generative-ai"); // Still keeping it for backward compatibility if needed, but will use fetch

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

async function scrapeArticle(url) {
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(data);
        
        // Remove scripts, styles, and navs to get cleaner text
        $('script, style, nav, footer, header').remove();
        
        const title = $('h1').first().text().trim();
        const content = $('p').map((i, el) => $(el).text()).get().join('\n').slice(0, 5000); // Limit to 5000 chars
        
        return { title, content };
    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        return null;
    }
}

app.post('/api/process-news', async (req, res) => {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Please provide an array of URLs' });
    }

    try {
        const scrapedData = await Promise.all(urls.map(url => scrapeArticle(url)));
        const validArticles = scrapedData.filter(a => a !== null);
        console.log(`Scraped ${validArticles.length} valid articles`);

        if (validArticles.length === 0) {
            console.error('No valid articles found');
            return res.status(400).json({ error: 'Could not extract content from any of the provided URLs' });
        }

        console.log('Building prompt...');
        const combinedPrompt = `
            Analyze the following news articles and generate professional social media content:
            
            ${validArticles.map((a, i) => `Article ${i+1}: ${a.title}\nContent: ${a.content}`).join('\n\n')}
            
            Based on this information, please provide:
            1. A highly engaging LinkedIn post. It should be professional yet punchy, using emojis and relevant hashtags.
            2. A sequence of 5 to 10 short texts for Instagram slides. Each slide should be concise and visual-ready. Format them as "Slide 1: [Text]", "Slide 2: [Text]", etc.
            
            Format your response as a JSON object with the following keys:
            - linkedinPost: string
            - instagramSlides: string[]
        `;

        console.log('Sending prompt to Gemini via fetch...');
        const payload = {
            contents: [{
                parts: [{ text: combinedPrompt }]
            }]
        };

        async function callGemini(retries = 2) {
            try {
                const result = await fetch(GEMINI_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await result.json();
                
                if (!result.ok) {
                    if (retries > 0 && (result.status === 503 || result.status === 429)) {
                        console.log(`Gemini API returned ${result.status}. Retrying in 2 seconds... (${retries} retries left)`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        return callGemini(retries - 1);
                    }
                    console.error('Gemini API error:', data);
                    const errorMsg = data.error ? data.error.message : 'Unknown error';
                    throw new Error(`Gemini API error (${result.status}): ${errorMsg}`);
                }
                return data;
            } catch (error) {
                if (retries > 0) {
                    console.log(`Request failed: ${error.message}. Retrying...`);
                    return callGemini(retries - 1);
                }
                throw error;
            }
        }

        const data = await callGemini();
        const responseText = data.candidates[0].content.parts[0].text;
        console.log('Gemini response received');
        
        // Attempt to parse JSON from AI response
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsedData = JSON.parse(jsonMatch[0]);
                console.log('Successfully parsed Gemini response');
                res.json(parsedData);
            } catch (e) {
                console.error('JSON Parse error:', e.message);
                res.status(500).json({ error: 'AI response format error', raw: responseText });
            }
        } else {
            console.error('No JSON found in AI response');
            res.status(500).json({ error: 'AI response format error', raw: responseText });
        }

    } catch (error) {
        console.error('Processing error:', error);
        let errorMsg = 'Error interno del servidor';
        if (error.message.includes('503')) {
            errorMsg = 'La IA está saturada en este momento (Error 503). Por favor, intenta de nuevo en unos segundos.';
        } else if (error.message.includes('429')) {
            errorMsg = 'Límite de cuota excedido (Error 429). Espera un momento antes de volver a intentar.';
        } else if (error.message.includes('404')) {
            errorMsg = 'Modelo de IA no encontrado. Verifica la configuración del servidor.';
        }
        res.status(500).json({ error: errorMsg });
    }
});

// Exportamos la app para que Vercel pueda consumirla como Serverless Function
module.exports = app;

// Solo iniciar el servidor web normal si estamos en local (no en Vercel)
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}
