package pricing

import (
	"math"

	"example.com/checkoutdemo/types"
)

// ItemTotal sums an item and, recursively, everything bundled inside it.
func ItemTotal(item types.Item) float64 {
	total := item.Price
	for _, child := range item.Children {
		total += ItemTotal(child)
	}
	return total
}

func CalculateTotal(items []types.Item) float64 {
	total := 0.0
	for _, item := range items {
		total += ItemTotal(item)
	}
	return roundMoney(total)
}

func ApplyDiscount(total float64, customer types.Customer) float64 {
	if customer.IsPremium {
		return applyPremiumDiscount(total)
	} else if total > 100 {
		return applyBulkDiscount(total)
	}
	return 0
}

func applyPremiumDiscount(total float64) float64 {
	return roundMoney(total * 0.2)
}

func applyBulkDiscount(total float64) float64 {
	return roundMoney(total * 0.05)
}

func roundMoney(value float64) float64 {
	return math.Round(value*100) / 100
}
